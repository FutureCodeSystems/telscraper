const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024;
const BASE_DIR = 'channels';

function fetchHTML(url, retries = 3) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000
        };

        const req = protocol.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchHTML(res.headers.location, retries - 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', (err) => {
            if (retries > 0) {
                setTimeout(() => fetchHTML(url, retries - 1).then(resolve).catch(reject), 2000);
            } else {
                reject(err);
            }
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        req.end();
    });
}

function getFileSize(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.request(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                getFileSize(res.headers.location).then(resolve);
                return;
            }
            resolve(parseInt(res.headers['content-length'] || 0));
        });
        req.on('error', () => resolve(0));
        req.setTimeout(5000, () => { req.destroy(); resolve(0); });
        req.end();
    });
}

function detectMediaType(url, buffer) {
    if (/\.(mp4|webm|mkv)(\?|$)/i.test(url)) return 'video';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return 'photo';
    if (/\.(pdf|zip|rar|apk|exe|doc|docx|xls)(\?|$)/i.test(url)) return 'document';
    if (/\.(mp3|ogg|wav|m4a)(\?|$)/i.test(url)) return 'audio';
    if (buffer && buffer.length > 12) {
        const head = buffer.slice(0, 12);
        if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return 'video';
        if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return 'video';
        if (head[0] === 0xFF && head[1] === 0xD8) return 'photo';
        if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'photo';
    }
    return 'document';
}

function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);
        let downloadedSize = 0;

        const req = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (downloadedSize > MAX_FILE_SIZE + 1024 * 1024) {
                    req.destroy();
                    file.close();
                    try { fs.unlinkSync(filepath); } catch (e) {}
                    reject(new Error('File too large'));
                }
            });

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    const stat = fs.statSync(filepath);
                    if (stat.size < 500) {
                        const buf = fs.readFileSync(filepath);
                        if (buf.toString().includes('<!DOCTYPE') || buf.toString().includes('<html')) {
                            fs.unlinkSync(filepath);
                            resolve(false);
                            return;
                        }
                    }
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', (err) => {
            file.close();
            try { fs.unlinkSync(filepath); } catch (e) {}
            reject(err);
        });
        req.setTimeout(30000, () => {
            req.destroy();
            file.close();
            try { fs.unlinkSync(filepath); } catch (e) {}
            reject(new Error('Download timeout'));
        });
        req.end();
    });
}

async function processMedia(channel, items, postId, index) {
    const mediaDir = path.join(BASE_DIR, channel, 'media');
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let url = item.full_url || item.url || item.thumbnail;
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No URL' });
            continue;
        }

        const size = await getFileSize(url);
        if (size > MAX_FILE_SIZE) {
            results.push({ ...item, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        const type = detectMediaType(url, null);
        let ext = 'bin';
        if (type === 'photo') ext = 'jpg';
        else if (type === 'video') ext = 'mp4';
        else if (type === 'audio') ext = 'mp3';
        else if (type === 'document') ext = path.extname(url).slice(1) || 'bin';

        const safePostId = postId.replace(/[\/\\]/g, '_');
        const filename = `${safePostId}_${index}_${i}.${ext}`;
        const filepath = path.join(mediaDir, type, filename);

        try {
            const success = await downloadFile(url, filepath);
            if (success) {
                const repoUrl = process.env.GITHUB_REPOSITORY || '';
                const branch = process.env.GITHUB_REF_NAME || 'main';
                const rawUrl = repoUrl ? `https://raw.githubusercontent.com/${repoUrl}/${branch}/${filepath.replace(/\\/g, '/')}` : null;
                results.push({
                    ...item,
                    type: type,
                    local_path: filepath.replace(/\\/g, '/'),
                    raw_url: rawUrl,
                    size_bytes: fs.statSync(filepath).size
                });
            } else {
                results.push({ ...item, local_path: null, remote_url: url, error: 'Not valid media' });
            }
        } catch (err) {
            results.push({ ...item, local_path: null, remote_url: url, error: err.message });
        }
    }
    return results;
}

function extractChannelInfo(html, channelId) {
    let avatar = null;
    let name = channelId;

    const avatarMatch = html.match(/<img class="tgme_page_photo_image"[^>]*src="([^"]+)"/);
    if (avatarMatch) avatar = avatarMatch[1];

    const nameMatch = html.match(/<div class="tgme_page_title">[\s\S]*?<span dir="auto">([^<]+)<\/span>/);
    if (nameMatch) name = nameMatch[1].trim();

    return { avatar, name };
}

function parsePosts(html, channelId) {
    const posts = [];
    const regex = /<div class="tgme_widget_message_wrap js-widget_message_wrap">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*(?=<div class="tgme_widget_message_wrap|<div class="tgme_widget_message_centered|<div class="tgme_footer|$)/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const block = match[1];
        const c = block.match(/data-post="([^"]+)"/);
        if (!c) continue;
        const postId = c[1];

        const post = {
            index: null,
            post_url: `https://t.me/${postId}`,
            post_id: postId,
            date: null,
            date_unix: null,
            edit_date: null,
            edit_date_unix: null,
            author: null,
            author_url: null,
            text: null,
            text_html: null,
            is_edited: false,
            views: null,
            views_raw: null,
            forward: { forwarded: false, from: null, from_url: null, date: null, date_unix: null },
            reply: { is_reply: false, to_url: null, to_text: null },
            pinned: false,
            media: { has_media: false, type: null, items: [] },
            poll: { has_poll: false, question: null, options: [], total_votes: null, is_anonymous: null, is_closed: false },
            buttons: [],
            hashtags: [],
            mentions: [],
            links: [],
            emoji: [],
            reactions: [],
            type: null
        };

        const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
        if (timeMatch) {
            post.date = timeMatch[1];
            post.date_unix = new Date(timeMatch[1]).getTime() / 1000;
        }

        const editTimeMatch = block.match(/<span class="tgme_widget_message_edit_date"[^>]*datetime="([^"]+)"/);
        if (editTimeMatch) {
            post.edit_date = editTimeMatch[1];
            post.edit_date_unix = new Date(editTimeMatch[1]).getTime() / 1000;
            post.is_edited = true;
        }

        const authorMatch = block.match(/<a class="tgme_widget_message_author_name"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>/);
        if (authorMatch) {
            post.author = authorMatch[2].replace(/<[^>]+>/g, '').trim();
            post.author_url = authorMatch[1];
        }

        const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (textMatch) {
            post.text_html = textMatch[1].trim();
            post.text = textMatch[1]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .trim();
        }

        const viewsMatch = block.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
        if (viewsMatch) {
            post.views_raw = viewsMatch[1];
            let num = parseFloat(viewsMatch[1]);
            if (viewsMatch[1].includes('K')) num = Math.round(num * 1000);
            else if (viewsMatch[1].includes('M')) num = Math.round(num * 1000000);
            post.views = num;
        }

        const forwardMatch = block.match(/<a class="tgme_widget_message_forwarded_from[^"]*" href="([^"]+)">\s*Forwarded from\s*(.*?)<\/a>/);
        if (forwardMatch) {
            post.forward.forwarded = true;
            post.forward.from = forwardMatch[2].replace(/<[^>]+>/g, '').trim();
            post.forward.from_url = forwardMatch[1];
            const fwdDate = block.match(/Forwarded from[\s\S]*?<time[^>]*datetime="([^"]+)"/);
            if (fwdDate) {
                post.forward.date = fwdDate[1];
                post.forward.date_unix = new Date(fwdDate[1]).getTime() / 1000;
            }
        }

        const replyMatch = block.match(/<a class="tgme_widget_message_reply"[^>]*href="([^"]+)"[^>]*>/);
        if (replyMatch) {
            post.reply.is_reply = true;
            post.reply.to_url = replyMatch[1];
            const replyTextMatch = block.match(/<div class="tgme_widget_message_reply_text"[^>]*>([\s\S]*?)<\/div>/);
            if (replyTextMatch) {
                post.reply.to_text = replyTextMatch[1].replace(/<[^>]+>/g, '').trim();
            }
        }

        post.pinned = block.includes('tgme_widget_message_pinned');

        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
        const seen = new Set();
        for (const c of cdns) {
            let url = c[0].replace(/[)"']+$/, '');
            if (seen.has(url)) continue;
            seen.add(url);
            let type = 'photo';
            if (/\.(mp4|webm)(\?|$)/i.test(url)) type = 'video';
            else if (/\.(pdf|zip|rar|apk)(\?|$)/i.test(url)) type = 'document';
            const fullUrl = url.replace(/thumb_\d+_/, '');
            const isThumb = url.includes('/thumb_');
            post.media.items.push({
                type,
                post_id: postId,
                url,
                full_url: fullUrl,
                thumbnail: isThumb ? url : null
            });
        }

        if (post.media.items.length > 0) {
            post.media.has_media = true;
            const types = [...new Set(post.media.items.map(x => x.type))];
            post.media.type = types.length > 1 ? 'mixed' : types[0];
            if (post.media.items.filter(x => x.type === 'photo').length > 1 && post.media.type === 'photo') {
                post.media.type = 'album';
            }
        }

        const pollQuestion = block.match(/<div class="tgme_widget_message_poll_question"[^>]*>(.*?)<\/div>/);
        if (pollQuestion) {
            post.poll.has_poll = true;
            post.poll.question = pollQuestion[1].replace(/<[^>]+>/g, '').trim();
            const opts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_text[^"]*">(.*?)<\/span>/g)];
            const pcts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_percent[^"]*">([^<]+)<\/span>/g)];
            opts.forEach((o, idx) => {
                post.poll.options.push({
                    index: idx + 1,
                    text: o[1].replace(/<[^>]+>/g, '').trim(),
                    percent: pcts[idx] ? parseFloat(pcts[idx][1]) : null
                });
            });
            const votesMatch = block.match(/<div class="tgme_widget_message_poll_votes"[^>]*>([^<]+)<\/div>/);
            if (votesMatch) post.poll.total_votes = votesMatch[1].trim();
            post.poll.is_anonymous = !block.includes('tgme_widget_message_poll_type_visible');
            post.poll.is_closed = block.includes('tgme_widget_message_poll_closed');
        }

        const buttons = [...block.matchAll(/<a class="tgme_widget_message_inline_button[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        post.buttons = buttons.map(b => ({
            text: b[2].replace(/<[^>]+>/g, '').trim(),
            url: b[1]
        }));

        post.hashtags = [...new Set([...block.matchAll(/#(\w+)/g)].map(m => m[1]))];
        post.mentions = [...new Set([...block.matchAll(/@(\w+)/g)].map(m => m[1]))];
        const links = [...block.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
        post.links = [...new Set(links.map(l => l[1]).filter(u => !u.includes('t.me/') && !u.includes('telesco.pe')))];
        post.emoji = [...new Set([...block.matchAll(/[\p{Emoji_Presentation}\u200D\uFE0F]/gu)].map(m => m[0]))];
        const reactions = [...block.matchAll(/<span class="tgme_widget_message_reaction_emoji"[^>]*>(.*?)<\/span>\s*<span class="tgme_widget_message_reaction_count"[^>]*>([^<]+)<\/span>/g)];
        post.reactions = reactions.map(r => ({ emoji: r[1].trim(), count: parseInt(r[2]) || 0 }));

        if (post.poll.has_poll) post.type = 'poll';
        else if (post.media.type === 'album') post.type = 'album';
        else if (post.media.type === 'photo') post.type = 'photo';
        else if (post.media.type === 'video') post.type = 'video';
        else if (post.media.type === 'document') post.type = 'document';
        else if (post.text) post.type = 'text';
        else post.type = 'media_only';

        posts.push(post);
    }

    posts.reverse();
    return posts;
}

async function fetchNewerPosts(channel, highestId, knownIds) {
    const newPosts = [];
    let missCount = 0;
    let id = highestId + 1;

    while (missCount < 3 && newPosts.length < 10) {
        const postId = `${channel}/${id}`;
        if (knownIds.has(postId)) {
            id++;
            continue;
        }

        const embedUrl = `https://t.me/${postId}?embed=1`;
        try {
            const html = await fetchHTML(embedUrl);
            if (html && html.includes('tgme_widget_message') && html.includes(`data-post="${postId}"`)) {
                const post = parseSinglePost(html, channel, id);
                if (post) {
                    newPosts.push(post);
                    knownIds.add(postId);
                    missCount = 0;
                }
            } else {
                missCount++;
            }
        } catch (err) {
            missCount++;
        }
        id++;
        await new Promise(r => setTimeout(r, 1500));
    }
    return newPosts;
}

function parseSinglePost(html, channel, postNum) {
    const postId = `${channel}/${postNum}`;
    const post = {
        index: null,
        post_url: `https://t.me/${postId}`,
        post_id: postId,
        date: null,
        date_unix: null,
        edit_date: null,
        edit_date_unix: null,
        author: null,
        author_url: null,
        text: null,
        text_html: null,
        is_edited: false,
        views: null,
        views_raw: null,
        forward: { forwarded: false, from: null, from_url: null, date: null, date_unix: null },
        reply: { is_reply: false, to_url: null, to_text: null },
        pinned: false,
        media: { has_media: false, type: null, items: [] },
        poll: { has_poll: false, question: null, options: [], total_votes: null, is_anonymous: null, is_closed: false },
        buttons: [],
        hashtags: [],
        mentions: [],
        links: [],
        emoji: [],
        reactions: [],
        type: null
    };

    const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"/);
    if (timeMatch) {
        post.date = timeMatch[1];
        post.date_unix = new Date(timeMatch[1]).getTime() / 1000;
    }

    const textMatch = html.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (textMatch) {
        post.text_html = textMatch[1].trim();
        post.text = textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    }

    const viewsMatch = html.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
    if (viewsMatch) {
        post.views_raw = viewsMatch[1];
        let num = parseFloat(viewsMatch[1]);
        if (viewsMatch[1].includes('K')) num = Math.round(num * 1000);
        else if (viewsMatch[1].includes('M')) num = Math.round(num * 1000000);
        post.views = num;
    }

    const cdns = [...html.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
    const seen = new Set();
    for (const c of cdns) {
        let url = c[0].replace(/[)"']+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        let type = 'photo';
        if (/\.(mp4|webm)(\?|$)/i.test(url)) type = 'video';
        else if (/\.(pdf|zip|rar|apk)(\?|$)/i.test(url)) type = 'document';
        const fullUrl = url.replace(/thumb_\d+_/, '');
        const isThumb = url.includes('/thumb_');
        post.media.items.push({
            type,
            post_id: postId,
            url,
            full_url: fullUrl,
            thumbnail: isThumb ? url : null
        });
    }

    if (post.media.items.length > 0) {
        post.media.has_media = true;
        const types = [...new Set(post.media.items.map(x => x.type))];
        post.media.type = types.length > 1 ? 'mixed' : types[0];
    }

    if (post.text) post.type = 'text';
    else if (post.media.has_media) post.type = 'media_only';
    else post.type = 'empty';

    return post;
}

async function fetchPosts(channel, maxPosts) {
    console.log(`🎯 Fetching ${maxPosts} posts from @${channel}`);

    const mainHtml = await fetchHTML(`https://t.me/s/${channel}`);
    if (!mainHtml || mainHtml.length < 500) throw new Error('Empty response from Telegram');

    const channelInfo = extractChannelInfo(mainHtml, channel);
    let posts = parsePosts(mainHtml, channel);

    if (posts.length === 0) return { channelInfo, posts: [] };

    posts.sort((a, b) => {
        const aNum = parseInt(a.post_id.split('/').pop()) || 0;
        const bNum = parseInt(b.post_id.split('/').pop()) || 0;
        return bNum - aNum;
    });

    const highestId = parseInt(posts[0].post_id.split('/').pop()) || 0;
    const knownIds = new Set(posts.map(p => p.post_id));

    const newerPosts = await fetchNewerPosts(channel, highestId, knownIds);
    if (newerPosts.length) {
        posts = [...newerPosts, ...posts];
    }

    posts = posts.slice(0, maxPosts);
    posts.forEach((p, idx) => p.index = idx + 1);

    return { channelInfo, posts };
}

async function main() {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '20');

    console.log(`\n🚀 Telegram Scraper v10`);
    console.log(`📺 @${channel} | 📊 Max posts: ${maxPosts}\n`);

    try {
        const { channelInfo, posts } = await fetchPosts(channel, maxPosts);

        if (posts.length === 0) {
            console.log('❌ No posts found');
            process.exit(0);
        }

        let totalMedia = posts.reduce((s, p) => s + p.media.items.length, 0);
        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            for (let i = 0; i < posts.length; i++) {
                const post = posts[i];
                if (post.media.items.length) {
                    console.log(`\n📝 ${post.post_id} (${post.media.items.length} items)`);
                    post.media.items = await processMedia(channel, post.media.items, post.post_id, i);
                }
            }
        }

        const outputData = {
            channel: {
                id: channel,
                name: channelInfo.name,
                avatar: channelInfo.avatar
            },
            posts: posts
        };

        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

        const dataPath = path.join(channelDir, 'data.json');
        fs.writeFileSync(dataPath, JSON.stringify(outputData, null, 2));

        const downloaded = posts.reduce((s, p) => s + p.media.items.filter(i => i.local_path).length, 0);
        const skipped = posts.reduce((s, p) => s + p.media.items.filter(i => !i.local_path && i.remote_url).length, 0);

        console.log(`\n✅ Done!`);
        console.log(`   💾 Saved: ${dataPath}`);
        console.log(`   📰 Posts: ${posts.length}`);
        console.log(`   📥 Downloaded: ${downloaded} files`);
        console.log(`   🔗 Remote only: ${skipped} files`);
        console.log(`\n📋 Posts:`);
        posts.forEach(p => {
            const mediaInfo = p.media.has_media ? ` [${p.media.type}: ${p.media.items.length}]` : '';
            console.log(`   ${p.index}. ${p.post_id} [${p.type}]${mediaInfo}`);
        });

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
