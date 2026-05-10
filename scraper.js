const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024;
const BASE_DIR = 'channels';

function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchHTML(res.headers.location).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', (e) => {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            https.get(proxyUrl, {}, (res2) => {
                let data2 = '';
                res2.on('data', chunk => data2 += chunk);
                res2.on('end', () => resolve(data2));
                res2.on('error', reject);
            }).on('error', reject);
        });
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

function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);

        protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
                return;
            }

            const ct = response.headers['content-type'] || '';
            if (ct.includes('text/html')) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                resolve(false);
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    const buf = fs.readFileSync(filepath);
                    if (buf.length < 500 && buf.toString().includes('<!DOCTYPE')) {
                        fs.unlinkSync(filepath);
                        resolve(false);
                        return;
                    }
                } catch (e) {}
                resolve(true);
            });
        }).on('error', (err) => {
            file.close();
            try { fs.unlinkSync(filepath); } catch (e) {}
            reject(err);
        });
    });
}

function getFileExtension(url, type) {
    const extMatch = url.match(/\.(\w+)(\?|$)/);
    if (extMatch) return extMatch[1].toLowerCase();
    return { 'photo': 'jpg', 'video': 'mp4', 'document': 'bin' }[type] || 'bin';
}

async function processMedia(channel, items) {
    const mediaDir = path.join(BASE_DIR, channel, 'media');
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.type || 'unknown';
        const typeDir = path.join(mediaDir, type);
        if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });

        let url = item.full_url || item.url || item.thumbnail;
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No URL' });
            continue;
        }

        console.log(`  📥 [${i+1}/${items.length}] ${url.substring(0, 80)}...`);

        const size = await getFileSize(url);
        if (size > MAX_FILE_SIZE) {
            console.log(`  ⚠️ Large (${(size/1024/1024).toFixed(1)}MB)`);
            results.push({ ...item, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        const ext = getFileExtension(url, type);
        const postId = (item.post_id || 'p').replace(/[\/\\]/g, '_');
        const filename = `${postId}_${i}.${ext}`;
        const filepath = path.join(typeDir, filename);

        try {
            const success = await downloadFile(url, filepath);
            if (success) {
                const repoUrl = process.env.GITHUB_REPOSITORY || 'user/repo';
                const branch = process.env.GITHUB_REF_NAME || 'main';
                const rawUrl = `https://raw.githubusercontent.com/${repoUrl}/${branch}/${filepath.replace(/\\/g, '/')}`;
                results.push({ ...item, local_path: filepath.replace(/\\/g, '/'), raw_url: rawUrl, size_bytes: fs.statSync(filepath).size });
                console.log(`  ✅`);
            } else {
                results.push({ ...item, local_path: null, remote_url: url, error: 'Not media' });
            }
        } catch (err) {
            results.push({ ...item, local_path: null, remote_url: url, error: err.message });
        }
    }

    return results;
}

function parsePosts(html) {
    const posts = [];
    const regex = /<div class="tgme_widget_message_wrap js-widget_message_wrap">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*(?=<div class="tgme_widget_message_wrap|<div class="tgme_widget_message_centered|<div class="tgme_footer|$)/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        const block = match[1];
        const c = block.match(/data-post="([^"]+)"/);
        if (!c) continue;
        const postId = c[1];

        const p = {
            index: null, post_url: `https://t.me/${postId}`, post_id: postId,
            date: null, date_unix: null, edit_date: null, edit_date_unix: null,
            author: null, author_url: null, text: null, text_html: null,
            is_edited: false, views: null, views_raw: null,
            forward: { forwarded: false, from: null, from_url: null, date: null, date_unix: null },
            reply: { is_reply: false, to_url: null, to_text: null },
            pinned: false,
            media: { has_media: false, type: null, items: [] },
            poll: { has_poll: false, question: null, options: [], total_votes: null, is_anonymous: null, is_closed: false },
            buttons: [], hashtags: [], mentions: [], links: [], emoji: [], reactions: [], type: null
        };

        const t = block.match(/<time[^>]*datetime="([^"]+)"/);
        if (t) { p.date = t[1]; p.date_unix = new Date(t[1]).getTime() / 1000; }

        const ts = [...block.matchAll(/<time[^>]*datetime="([^"]+)"/g)];
        if (ts.length > 1) { p.edit_date = ts[1][1]; p.edit_date_unix = new Date(ts[1][1]).getTime() / 1000; p.is_edited = true; }

        const a = block.match(/<a class="tgme_widget_message_author_name"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>/);
        if (a) { p.author = a[2].replace(/<[^>]+>/g, '').trim(); p.author_url = a[1]; }

        const txt = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (txt) {
            p.text_html = txt[1].trim();
            p.text = txt[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        }

        const v = block.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
        if (v) { p.views_raw = v[1]; const n = parseFloat(v[1]); p.views = v[1].includes('K') ? Math.round(n * 1000) : v[1].includes('M') ? Math.round(n * 1000000) : Math.round(n); }

        const fwd = block.match(/<a class="tgme_widget_message_forwarded_from[^"]*" href="([^"]+)">\s*Forwarded from\s*([^<]+)<\/a>/);
        if (fwd) {
            p.forward.forwarded = true; p.forward.from = fwd[2].trim(); p.forward.from_url = fwd[1];
            const fd = block.match(/Forwarded from[\s\S]*?<time[^>]*datetime="([^"]+)"/);
            if (fd) { p.forward.date = fd[1]; p.forward.date_unix = new Date(fd[1]).getTime() / 1000; }
        }

        const rep = block.match(/<a class="tgme_widget_message_reply"[^>]*href="([^"]+)"[^>]*>/);
        if (rep) {
            p.reply.is_reply = true; p.reply.to_url = rep[1];
            const rt = block.match(/<div class="tgme_widget_message_reply_text"[^>]*>([\s\S]*?)<\/div>/);
            if (rt) p.reply.to_text = rt[1].replace(/<[^>]+>/g, '').trim();
        }

        p.pinned = block.includes('tgme_widget_message_pinned');

        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
        const seen = new Set();
        cdns.forEach(c => {
            const url = c[0].replace(/[)"']+$/, '');
            if (seen.has(url)) return;
            seen.add(url);

            let type = 'photo';
            if (/\.(mp4|webm)(\?|$)/i.test(url)) type = 'video';
            else if (/\.(pdf|zip|rar|apk)(\?|$)/i.test(url)) type = 'document';

            p.media.items.push({ type, post_id: postId, url, full_url: url.replace(/thumb_\d+_/, ''), thumbnail: url.includes('/thumb_') ? url : null });
        });

        if (p.media.items.length > 0) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length > 1 ? 'mixed' : types[0];
            if (p.media.items.filter(x => x.type === 'photo').length > 1 && p.media.type === 'photo') p.media.type = 'album';
        }

        if (block.includes('<div class="tgme_widget_message_poll')) {
            p.poll.has_poll = true;
            const q = block.match(/<div class="tgme_widget_message_poll_question"[^>]*>(.*?)<\/div>/);
            if (q) p.poll.question = q[1].replace(/<[^>]+>/g, '').trim();
            const opts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_text[^"]*">(.*?)<\/span>/g)];
            const pcts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_percent[^"]*">([^<]+)<\/span>/g)];
            opts.forEach((o, j) => p.poll.options.push({ index: j + 1, text: o[1].replace(/<[^>]+>/g, '').trim(), percent: pcts[j] ? parseFloat(pcts[j][1]) : null }));
            const vts = block.match(/<div class="tgme_widget_message_poll_votes"[^>]*>([^<]+)<\/div>/);
            if (vts) p.poll.total_votes = vts[1].trim();
            p.poll.is_anonymous = !block.includes('tgme_widget_message_poll_type_visible');
            p.poll.is_closed = block.includes('tgme_widget_message_poll_closed');
        }

        const btns = [...block.matchAll(/<a class="tgme_widget_message_inline_button[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        p.buttons = btns.map(b => ({ text: b[2].replace(/<[^>]+>/g, '').trim(), url: b[1] }));
        p.hashtags = [...new Set([...block.matchAll(/#(\w+)/g)].map(m => m[1]))];
        p.mentions = [...new Set([...block.matchAll(/@(\w+)/g)].map(m => m[1]))];
        const lks = [...block.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
        p.links = [...new Set(lks.map(l => l[1]).filter(u => !u.includes('t.me/') && !u.includes('telesco.pe')))];
        p.emoji = [...new Set([...block.matchAll(/[\p{Emoji_Presentation}\u200D\uFE0F]/gu)].map(m => m[0]))];
        const reacts = [...block.matchAll(/<span class="tgme_widget_message_reaction_emoji"[^>]*>(.*?)<\/span>\s*<span class="tgme_widget_message_reaction_count"[^>]*>([^<]+)<\/span>/g)];
        p.reactions = reacts.map(r => ({ emoji: r[1].trim(), count: parseInt(r[2]) || 0 }));

        // Type detection - DON'T filter empty posts here
        if (p.poll.has_poll) p.type = 'poll';
        else if (p.media.type === 'album') p.type = 'album';
        else if (p.media.type === 'photo') p.type = 'photo';
        else if (p.media.type === 'video') p.type = 'video';
        else if (p.media.type === 'document') p.type = 'document';
        else if (p.text) p.type = 'text';
        else p.type = 'media_only'; // Keep media-only posts!

        posts.push(p);
    }

    // REVERSE to get newest first
    posts.reverse();
    return posts;
}

async function fetchPosts(channel, maxPosts) {
    let allPosts = [];
    let before = null;
    let page = 1;

    console.log(`🎯 Getting ${maxPosts} latest posts from @${channel}`);

    while (allPosts.length < maxPosts) {
        let url = `https://t.me/s/${channel}`;
        if (before) url += `?before=${before}`;

        console.log(`📄 Page ${page}: fetching...`);

        const html = await fetchHTML(url);
        if (!html || html.length < 500) {
            console.log(`   ❌ Empty response`);
            break;
        }

        const posts = parsePosts(html);
        if (posts.length === 0) {
            console.log(`   No posts found`);
            break;
        }

        console.log(`   Got ${posts.length} posts: ${posts[0].post_id} ← ${posts[posts.length-1].post_id}`);

        // Check for new posts we haven't seen
        const newPosts = posts.filter(p => !allPosts.some(ap => ap.post_id === p.post_id));
        
        if (newPosts.length === 0) {
            console.log(`   No new posts, stopping`);
            break;
        }

        allPosts = allPosts.concat(newPosts);

        // Sort by date_unix descending
        allPosts.sort((a, b) => (b.date_unix || 0) - (a.date_unix || 0));
        
        // Trim to maxPosts
        if (allPosts.length > maxPosts * 2) {
            allPosts = allPosts.slice(0, maxPosts * 2);
        }

        console.log(`   Total: ${allPosts.length} unique posts`);

        if (allPosts.length >= maxPosts) break;

        // Go older
        before = posts[posts.length - 1].post_id?.split('/').pop();
        if (!before) break;

        page++;
        await new Promise(r => setTimeout(r, 2000));
    }

    // Final sort and slice
    allPosts.sort((a, b) => (b.date_unix || 0) - (a.date_unix || 0));
    const result = allPosts.slice(0, maxPosts);

    console.log(`\n📊 Final:`);
    result.forEach((p, i) => console.log(`   ${i+1}. ${p.post_id} [${p.type}]`));

    return result;
}

// Main
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '5');

    console.log(`\n🚀 Telegram Scraper v8`);
    console.log(`📺 @${channel} | 📊 ${maxPosts} latest posts\n`);

    try {
        const posts = await fetchPosts(channel, maxPosts);
        if (posts.length === 0) { console.log('❌ No posts'); process.exit(0); }

        let totalMedia = 0;
        posts.forEach(p => totalMedia += p.media.items.length);

        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 ${post.post_id} (${post.media.items.length})`);
                    post.media.items = await processMedia(channel, post.media.items);
                }
            }
        }

        // DON'T filter - keep all posts including media_only
        posts.forEach((p, i) => p.index = i + 1);

        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });
        fs.writeFileSync(path.join(channelDir, 'data.json'), JSON.stringify(posts, null, 2));

        const downloaded = posts.reduce((s, p) => s + p.media.items.filter(i => i.local_path).length, 0);
        console.log(`\n✅ ${posts.length} posts | ${downloaded} files`);
        posts.forEach(p => console.log(`   ${p.index}. ${p.post_id} [${p.type}]`));

    } catch (error) {
        console.error('❌', error.message);
        process.exit(1);
    }
})();
