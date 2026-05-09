const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024; // 90MB
const BASE_DIR = 'channels';

async function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
        const req = protocol.request(url, { method: 'HEAD' }, (res) => {
            const size = parseInt(res.headers['content-length'] || 0);
            resolve(size);
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
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(true); });
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

async function processMedia(channel, items) {
    const mediaDir = path.join(BASE_DIR, channel, 'media');
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.type || 'unknown';
        const typeDir = path.join(mediaDir, type);

        if (!fs.existsSync(typeDir)) {
            fs.mkdirSync(typeDir, { recursive: true });
        }

        const url = item.url || item.full_url || item.thumbnail;
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No valid URL' });
            continue;
        }

        const size = await getFileSize(url);
        if (size === 0) {
            results.push({ ...item, local_path: null, remote_url: url, error: 'Could not determine size' });
            continue;
        }

        if (size > MAX_FILE_SIZE) {
            console.log(`  ⚠️ Large file (${(size/1024/1024).toFixed(1)}MB), linking only`);
            results.push({ ...item, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        const ext = getFileExtension(url, type);
        const postId = (item.post_id || 'unknown').replace(/[\/\\]/g, '_');
        const filename = `${postId}_${Date.now()}_${i}.${ext}`;
        const filepath = path.join(typeDir, filename);

        try {
            console.log(`  💾 Downloading (${(size/1024/1024).toFixed(1)}MB)...`);
            await downloadFile(url, filepath);

            const repoUrl = process.env.GITHUB_REPOSITORY || 'user/repo';
            const branch = process.env.GITHUB_REF_NAME || 'main';
            const relativePath = filepath.replace(/\\/g, '/');
            const rawUrl = `https://raw.githubusercontent.com/${repoUrl}/${branch}/${relativePath}`;

            results.push({ ...item, local_path: relativePath, raw_url: rawUrl, size_bytes: size });
            console.log(`  ✅ Saved`);
        } catch (err) {
            console.log(`  ❌ Failed: ${err.message}`);
            results.push({ ...item, local_path: null, remote_url: url, error: err.message });
        }
    }

    return results;
}

function parsePosts(html, channel) {
    const posts = [];
    const blocks = html.split(/<div class="tgme_widget_message_wrap[^"]*">/);
    blocks.shift();

    blocks.forEach((block) => {
        const p = {
            index: null,
            post_url: null,
            post_id: null,
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

        const c = block.match(/data-post="([^"]+)"/);
        if (c) { p.post_id = c[1]; p.post_url = `https://t.me/${c[1]}`; }

        const t = block.match(/<time[^>]*datetime="([^"]+)"[^>]*>/);
        if (t) { p.date = t[1]; p.date_unix = new Date(t[1]).getTime() / 1000; }

        const ts = [...block.matchAll(/<time[^>]*datetime="([^"]+)"[^>]*>/g)];
        if (ts.length > 1) { p.edit_date = ts[1][1]; p.edit_date_unix = new Date(ts[1][1]).getTime() / 1000; p.is_edited = true; }

        const a = block.match(/<a class="tgme_widget_message_author_name"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>/);
        if (a) { p.author = a[2].replace(/<[^>]+>/g, '').trim(); p.author_url = a[1]; }

        const txt = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (txt) {
            p.text_html = txt[1].trim();
            p.text = txt[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        }

        const v = block.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
        if (v) {
            p.views_raw = v[1];
            const n = parseFloat(v[1]);
            p.views = v[1].includes('K') ? Math.round(n * 1000) : v[1].includes('M') ? Math.round(n * 1000000) : Math.round(n);
        }

        const fwd = block.match(/<a class="tgme_widget_message_forwarded_from[^"]*" href="([^"]+)">\s*Forwarded from\s*([^<]+)<\/a>/);
        if (fwd) {
            p.forward.forwarded = true;
            p.forward.from = fwd[2].trim();
            p.forward.from_url = fwd[1];
            const fd = block.match(/Forwarded from[\s\S]*?<time[^>]*datetime="([^"]+)"[^>]*>/);
            if (fd) { p.forward.date = fd[1]; p.forward.date_unix = new Date(fd[1]).getTime() / 1000; }
        }

        const rep = block.match(/<a class="tgme_widget_message_reply"[^>]*href="([^"]+)"[^>]*>/);
        if (rep) {
            p.reply.is_reply = true;
            p.reply.to_url = rep[1];
            const rt = block.match(/<div class="tgme_widget_message_reply_text"[^>]*>([\s\S]*?)<\/div>/);
            if (rt) p.reply.to_text = rt[1].replace(/<[^>]+>/g, '').trim();
        }

        p.pinned = block.includes('tgme_widget_message_pinned');

        const photos = [...block.matchAll(/<a class="tgme_widget_message_photo_wrap[^"]*"(?: href="([^"]+)")?[^>]*style="[^"]*background-image:\s*url\('([^']+)'\)/g)];
        photos.forEach(ph => {
            p.media.items.push({
                type: 'photo',
                post_id: p.post_id,
                page_url: ph[1] || null,
                thumbnail: ph[2] || null,
                full_url: (ph[1] || ph[2] || '').replace(/thumb_\d+_/, '')
            });
        });

        const videos = [...block.matchAll(/<video[^>]*src="([^"]+)"[^>]*>/g)];
        videos.forEach(vi => p.media.items.push({ type: 'video', post_id: p.post_id, url: vi[1] }));

        const docs = [...block.matchAll(/<a class="tgme_widget_message_document_wrap[^"]*" href="([^"]+)"[^>]*>/g)];
        docs.forEach(d => {
            const item = { type: 'document', post_id: p.post_id, url: d[1] };
            const ti = block.match(/<div class="tgme_widget_message_document_title"[^>]*>([\s\S]*?)<\/div>/);
            if (ti) item.title = ti[1].replace(/<[^>]+>/g, '').trim();
            const sz = block.match(/<div class="tgme_widget_message_document_extra"[^>]*>([\d.]+ [KMGT]B)<\/div>/);
            if (sz) item.size = sz[1];
            p.media.items.push(item);
        });

        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>]+/g)];
        cdns.forEach(c => {
            if (!p.media.items.some(x => JSON.stringify(x).includes(c[0]))) {
                p.media.items.push({ type: 'unknown', post_id: p.post_id, url: c[0] });
            }
        });

        if (p.media.items.length) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length > 1 ? 'mixed' : types[0];
            if (photos.length > 1 && p.media.type === 'photo') p.media.type = 'album';
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

        if (p.poll.has_poll) p.type = 'poll';
        else if (p.media.type === 'album') p.type = 'album';
        else if (p.media.type === 'photo') p.type = 'photo';
        else if (p.media.type === 'video') p.type = 'video';
        else if (p.media.type === 'document') p.type = 'document';
        else if (p.text) p.type = 'text';
        else p.type = 'empty';

        posts.push(p);
    });

    return posts;
}

async function fetchAllPosts(channel, maxPosts) {
    let allPosts = [];
    let beforeId = null;
    let page = 1;

    console.log(`🎯 Target: ${maxPosts} posts from @${channel}`);

    while (allPosts.length < maxPosts) {
        let url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://t.me/s/${channel}`)}`;
        if (beforeId) {
            url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://t.me/s/${channel}?before=${beforeId}`)}`;
        }

        console.log(`📄 Fetching page ${page}${beforeId ? ` (before ${beforeId})` : ''}...`);

        let html;
        try {
            html = await fetchHTML(url);
        } catch (e) {
            console.log(`❌ Failed to fetch page ${page}: ${e.message}`);
            break;
        }

        const posts = parsePosts(html, channel);

        if (posts.length === 0) {
            console.log('🏁 No more posts found');
            break;
        }

        console.log(`   Got ${posts.length} posts from this page`);

        allPosts = allPosts.concat(posts);
        console.log(`   Total so far: ${allPosts.length}/${maxPosts}`);

        if (allPosts.length >= maxPosts) break;

        const lastPost = posts[posts.length - 1];
        if (lastPost && lastPost.post_id) {
            const postNum = lastPost.post_id.split('/').pop();
            beforeId = postNum;
        } else {
            break;
        }

        page++;
        await new Promise(r => setTimeout(r, 1000));
    }

    return allPosts.slice(0, maxPosts);
}

// Main
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '20');

    console.log(`\n🚀 Telegram Scraper`);
    console.log(`📺 Channel: @${channel}`);
    console.log(`📊 Max posts: ${maxPosts}`);
    console.log(`📁 Max file size: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    console.log(`📂 Base directory: ${BASE_DIR}/${channel}/\n`);

    try {
        // Create channel directory
        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

        // Fetch posts
        const posts = await fetchAllPosts(channel, maxPosts);

        if (posts.length === 0) {
            console.log('❌ No posts found!');
            process.exit(1);
        }

        // Assign correct indexes
        posts.forEach((p, i) => p.index = i + 1);

        // Process media
        let totalMedia = 0;
        posts.forEach(p => totalMedia += p.media.items.length);

        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            let processed = 0;
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 Post #${post.index} (${post.media.items.length} items - ${processed}/${totalMedia} done)`);
                    post.media.items = await processMedia(channel, post.media.items);
                    processed += post.media.items.length;
                }
            }
        }

        // Filter empty posts
        const filtered = posts.filter(p => p.type !== 'empty' || p.text);
        filtered.forEach((p, i) => p.index = i + 1);

        // Save data.json inside channel folder
        const dataPath = path.join(channelDir, 'data.json');
        fs.writeFileSync(dataPath, JSON.stringify(filtered, null, 2));

        // Create .gitkeep files
        const mediaDir = path.join(channelDir, 'media');
        if (fs.existsSync(mediaDir)) {
            const dirs = fs.readdirSync(mediaDir, { withFileTypes: true });
            dirs.filter(d => d.isDirectory()).forEach(d => {
                const gitkeep = path.join(mediaDir, d.name, '.gitkeep');
                if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, '');
            });
        }

        // Create channels/.gitkeep
        if (!fs.existsSync(path.join(BASE_DIR, '.gitkeep'))) {
            fs.writeFileSync(path.join(BASE_DIR, '.gitkeep'), '');
        }

        // Stats
        const stats = {
            channel: `@${channel}`,
            scraped_at: new Date().toISOString(),
            total_posts: filtered.length,
            media_stats: {}
        };

        filtered.forEach(p => {
            if (p.media.has_media) {
                stats.media_stats[p.media.type] = (stats.media_stats[p.media.type] || 0) + 1;
            }
        });

        console.log(`\n📊 Stats:`);
        console.log(`   Posts: ${stats.total_posts}`);
        Object.entries(stats.media_stats).forEach(([type, count]) => {
            console.log(`   ${type}: ${count}`);
        });

        console.log(`\n✅ Done! Data saved to ${dataPath}`);

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
})();
