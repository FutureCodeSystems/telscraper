const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024;
const BASE_DIR = 'channels';
const PROXY = 'https://api.codetabs.com/v1/proxy?quest=';

function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        const fullUrl = PROXY + encodeURIComponent(url);
        https.get(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
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

            const contentType = response.headers['content-type'] || '';
            if (contentType.includes('text/html')) {
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
    const defaults = { 'photo': 'jpg', 'video': 'mp4', 'document': 'bin', 'voice': 'ogg', 'audio': 'mp3' };
    return defaults[type] || 'bin';
}

function isProfilePhoto(url, channel) {
    // Filter out channel avatar/profile photos
    // They usually appear in tgme_page_photo or channel info section
    if (!url.includes('telesco.pe/file/')) return false;
    
    // Profile photos have specific patterns
    const hash = url.split('/file/').pop()?.split('.')[0] || '';
    
    // Very long hashes are usually post media
    // Short hashes or specific channel avatar patterns
    if (hash.length < 20) return true;
    
    return false;
}

async function processMedia(channel, items) {
    const mediaDir = path.join(BASE_DIR, channel, 'media');
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.type || 'unknown';
        const typeDir = path.join(mediaDir, type);
        if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });

        let url = item.url || item.full_url || item.thumbnail;
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No URL' });
            continue;
        }

        // Skip profile photos
        if ((item.type === 'photo' || type === 'unknown') && isProfilePhoto(url, channel)) {
            console.log(`  🚫 Skipping (profile photo)`);
            results.push({ ...item, local_path: null, remote_url: url, skipped: 'profile_photo' });
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

function parsePosts(html, channel) {
    const posts = [];
    
    // Find all message blocks - they contain data-post attribute
    const messageRegex = /<div class="tgme_widget_message[^"]*"\s+data-post="([^"]+)"[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/g;
    let match;
    
    while ((match = messageRegex.exec(html)) !== null) {
        const block = match[0];
        const postId = match[1];
        
        const p = {
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

        // Date
        const t = block.match(/<time[^>]*datetime="([^"]+)"/);
        if (t) { p.date = t[1]; p.date_unix = new Date(t[1]).getTime() / 1000; }

        // Edited
        const ts = [...block.matchAll(/<time[^>]*datetime="([^"]+)"/g)];
        if (ts.length > 1) { p.edit_date = ts[1][1]; p.edit_date_unix = new Date(ts[1][1]).getTime() / 1000; p.is_edited = true; }

        // Author
        const a = block.match(/<a class="tgme_widget_message_author_name"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>/);
        if (a) { p.author = a[2].replace(/<[^>]+>/g, '').trim(); p.author_url = a[1]; }

        // Text
        const txt = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (txt) {
            p.text_html = txt[1].trim();
            p.text = txt[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        }

        // Views
        const v = block.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
        if (v) {
            p.views_raw = v[1];
            const n = parseFloat(v[1]);
            p.views = v[1].includes('K') ? Math.round(n * 1000) : v[1].includes('M') ? Math.round(n * 1000000) : Math.round(n);
        }

        // Forward
        const fwd = block.match(/<a class="tgme_widget_message_forwarded_from[^"]*" href="([^"]+)">\s*Forwarded from\s*([^<]+)<\/a>/);
        if (fwd) {
            p.forward.forwarded = true;
            p.forward.from = fwd[2].trim();
            p.forward.from_url = fwd[1];
            const fd = block.match(/Forwarded from[\s\S]*?<time[^>]*datetime="([^"]+)"/);
            if (fd) { p.forward.date = fd[1]; p.forward.date_unix = new Date(fd[1]).getTime() / 1000; }
        }

        // Reply
        const rep = block.match(/<a class="tgme_widget_message_reply"[^>]*href="([^"]+)"[^>]*>/);
        if (rep) {
            p.reply.is_reply = true;
            p.reply.to_url = rep[1];
            const rt = block.match(/<div class="tgme_widget_message_reply_text"[^>]*>([\s\S]*?)<\/div>/);
            if (rt) p.reply.to_text = rt[1].replace(/<[^>]+>/g, '').trim();
        }

        p.pinned = block.includes('tgme_widget_message_pinned');

        // Extract ALL CDN URLs from this message block
        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
        const seen = new Set();
        
        cdns.forEach(c => {
            const url = c[0].replace(/[)"']+$/, ''); // Clean trailing chars
            
            if (seen.has(url)) return;
            seen.add(url);

            // Skip if it's a profile photo
            // Profile photos in message blocks are rare, but we check anyway
            const hash = url.split('/file/').pop()?.split('.')[0] || '';
            if (hash.length < 20) return; // Skip short hashes (profile pics)

            // Determine type
            let type = 'photo';
            if (/\.(mp4|webm|avi|mov|mkv)(\?|$)/i.test(url)) type = 'video';
            else if (/\.(mp3|ogg|wav)(\?|$)/i.test(url)) type = 'audio';
            else if (/\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|apk|exe)(\?|$)/i.test(url)) type = 'document';

            const fullUrl = url.includes('/thumb_') ? url.replace(/thumb_\d+_/, '') : url;

            p.media.items.push({
                type,
                post_id: postId,
                url: url,
                full_url: fullUrl,
                thumbnail: url.includes('/thumb_') ? url : null
            });
        });

        if (p.media.items.length > 0) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length > 1 ? 'mixed' : types[0];
            if (p.media.items.filter(x => x.type === 'photo').length > 1 && p.media.type === 'photo') {
                p.media.type = 'album';
            }
        }

        // Poll
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

        // Buttons, hashtags, mentions, links, emoji, reactions
        const btns = [...block.matchAll(/<a class="tgme_widget_message_inline_button[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        p.buttons = btns.map(b => ({ text: b[2].replace(/<[^>]+>/g, '').trim(), url: b[1] }));
        p.hashtags = [...new Set([...block.matchAll(/#(\w+)/g)].map(m => m[1]))];
        p.mentions = [...new Set([...block.matchAll(/@(\w+)/g)].map(m => m[1]))];
        const lks = [...block.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
        p.links = [...new Set(lks.map(l => l[1]).filter(u => !u.includes('t.me/') && !u.includes('telesco.pe')))];
        p.emoji = [...new Set([...block.matchAll(/[\p{Emoji_Presentation}\u200D\uFE0F]/gu)].map(m => m[0]))];
        const reacts = [...block.matchAll(/<span class="tgme_widget_message_reaction_emoji"[^>]*>(.*?)<\/span>\s*<span class="tgme_widget_message_reaction_count"[^>]*>([^<]+)<\/span>/g)];
        p.reactions = reacts.map(r => ({ emoji: r[1].trim(), count: parseInt(r[2]) || 0 }));

        // Type
        if (p.poll.has_poll) p.type = 'poll';
        else if (p.media.type === 'album') p.type = 'album';
        else if (p.media.type === 'photo') p.type = 'photo';
        else if (p.media.type === 'video') p.type = 'video';
        else if (p.media.type === 'document') p.type = 'document';
        else if (p.text) p.type = 'text';
        else p.type = 'empty';

        posts.push(p);
    }

    return posts;
}

async function fetchPosts(channel, maxPosts) {
    let allPosts = [];
    let beforeId = null;
    let page = 1;

    console.log(`🎯 Getting ${maxPosts} latest posts from @${channel}`);

    while (allPosts.length < maxPosts) {
        let url = `https://t.me/s/${channel}`;
        if (beforeId) url += `?before=${beforeId}`;

        console.log(`📄 Page ${page}: ${url}`);

        let html;
        try {
            html = await fetchHTML(url);
        } catch (e) {
            console.log(`❌ ${e.message}`);
            break;
        }

        const posts = parsePosts(html, channel);
        
        if (posts.length === 0) {
            console.log(`   No posts found`);
            break;
        }

        console.log(`   Got ${posts.length} posts: ${posts[0].post_id} → ${posts[posts.length-1].post_id}`);

        allPosts = allPosts.concat(posts);

        if (allPosts.length >= maxPosts) break;

        // Get the LAST (oldest) post ID from this page to load OLDER posts
        beforeId = posts[posts.length - 1].post_id?.split('/').pop();
        if (!beforeId) break;

        page++;
        await new Promise(r => setTimeout(r, 1500)); // Rate limit for codetabs
    }

    // NOW REVERSE: page 1 has newest, page 2 has older, etc.
    // After reverse, index 0 = newest
    const result = allPosts.slice(0, maxPosts);
    
    console.log(`\n📊 Final order (newest first):`);
    console.log(`   First (newest): ${result[0]?.post_id}`);
    console.log(`   Last (oldest): ${result[result.length-1]?.post_id}`);

    return result;
}

// Main
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '4');

    console.log(`\n🚀 Telegram Scraper v4`);
    console.log(`📺 @${channel} | 📊 ${maxPosts} latest posts`);
    console.log(`🔗 Proxy: codetabs\n`);

    try {
        const posts = await fetchPosts(channel, maxPosts);
        if (posts.length === 0) { console.log('❌ No posts'); process.exit(1); }

        // Process media
        let totalMedia = 0;
        posts.forEach(p => totalMedia += p.media.items.length);

        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 ${post.post_id} (${post.media.items.length} items)`);
                    post.media.items = await processMedia(channel, post.media.items);
                }
            }
        }

        // Filter & index (1 = newest)
        const filtered = posts.filter(p => p.type !== 'empty' || p.text);
        filtered.forEach((p, i) => p.index = i + 1);

        // Save
        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });
        fs.writeFileSync(path.join(channelDir, 'data.json'), JSON.stringify(filtered, null, 2));

        const downloaded = filtered.reduce((s, p) => s + p.media.items.filter(i => i.local_path).length, 0);
        console.log(`\n✅ ${filtered.length} posts | ${downloaded} files | saved to ${channelDir}/data.json`);

        // Show order
        console.log(`\n📋 Post order:`);
        filtered.forEach(p => console.log(`   ${p.index}. ${p.post_id} [${p.type}]`));

    } catch (error) {
        console.error('❌', error.message);
        process.exit(1);
    }
})();
