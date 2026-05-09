const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024;
const BASE_DIR = 'channels';

function fetchHTML(url) {
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
            if (contentType.includes('text/html') || contentType.includes('application/xml')) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                resolve(false);
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    const stat = fs.statSync(filepath);
                    if (stat.size < 500) {
                        const content = fs.readFileSync(filepath, 'utf8');
                        if (content.includes('<!DOCTYPE') || content.includes('<html')) {
                            fs.unlinkSync(filepath);
                            resolve(false);
                            return;
                        }
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
    return type === 'photo' ? 'jpg' : type === 'video' ? 'mp4' : 'bin';
}

function isProfilePhoto(url) {
    // Skip channel profile photos (usually the last CDN URL in page header, not in posts)
    if (url.match(/[a-zA-Z0-9_-]{30,}\.[a-z]+$/)) return true;
    if (url.includes('avatar') || url.includes('aO18')) return true;
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

        if (isProfilePhoto(url)) {
            console.log(`  🚫 Profile photo skipped`);
            results.push({ ...item, local_path: null, remote_url: url, skipped: 'profile' });
            continue;
        }

        const size = await getFileSize(url);
        if (size > MAX_FILE_SIZE) {
            console.log(`  ⚠️ ${(size/1024/1024).toFixed(1)}MB (remote only)`);
            results.push({ ...item, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        const ext = getFileExtension(url, type);
        const postId = (item.post_id || 'x').replace(/[\/\\]/g, '_');
        const filename = `${postId}_${i}.${ext}`;
        const filepath = path.join(typeDir, filename);

        try {
            const ok = await downloadFile(url, filepath);
            if (ok) {
                const repoUrl = process.env.GITHUB_REPOSITORY || 'x/x';
                const branch = process.env.GITHUB_REF_NAME || 'main';
                const rel = filepath.replace(/\\/g, '/');
                const raw = `https://raw.githubusercontent.com/${repoUrl}/${branch}/${rel}`;
                const fsSize = fs.statSync(filepath).size;
                results.push({ ...item, local_path: rel, raw_url: raw, size_bytes: fsSize });
                console.log(`  ✅ ${(fsSize/1024).toFixed(1)}KB`);
            } else {
                results.push({ ...item, local_path: null, remote_url: url, error: 'HTML' });
            }
        } catch (e) {
            results.push({ ...item, local_path: null, remote_url: url, error: e.message });
        }
    }

    return results;
}

function parsePosts(html) {
    const posts = [];
    const blocks = html.split(/<div class="tgme_widget_message_wrap[^"]*">/);
    blocks.shift();

    blocks.forEach((block) => {
        const p = {
            index: null, post_id: null, post_url: null,
            date: null, date_unix: null,
            edit_date: null, edit_date_unix: null, is_edited: false,
            author: null, author_url: null,
            text: null, text_html: null,
            views: null, views_raw: null,
            forward: { forwarded: false, from: null, from_url: null, date: null, date_unix: null },
            reply: { is_reply: false, to_url: null, to_text: null },
            pinned: false,
            media: { has_media: false, type: null, items: [] },
            poll: { has_poll: false, question: null, options: [], total_votes: null, is_anonymous: null, is_closed: false },
            buttons: [], hashtags: [], mentions: [], links: [], emoji: [], reactions: [],
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
        if (v) { p.views_raw = v[1]; const n = parseFloat(v[1]); p.views = v[1].includes('K') ? Math.round(n * 1000) : v[1].includes('M') ? Math.round(n * 1000000) : Math.round(n); }

        const fwd = block.match(/<a class="tgme_widget_message_forwarded_from[^"]*" href="([^"]+)">\s*Forwarded from\s*([^<]+)<\/a>/);
        if (fwd) {
            p.forward.forwarded = true; p.forward.from = fwd[2].trim(); p.forward.from_url = fwd[1];
            const fd = block.match(/Forwarded from[\s\S]*?<time[^>]*datetime="([^"]+)"[^>]*>/);
            if (fd) { p.forward.date = fd[1]; p.forward.date_unix = new Date(fd[1]).getTime() / 1000; }
        }

        const rep = block.match(/<a class="tgme_widget_message_reply"[^>]*href="([^"]+)"[^>]*>/);
        if (rep) { p.reply.is_reply = true; p.reply.to_url = rep[1]; const rt = block.match(/<div class="tgme_widget_message_reply_text"[^>]*>([\s\S]*?)<\/div>/); if (rt) p.reply.to_text = rt[1].replace(/<[^>]+>/g, '').trim(); }

        p.pinned = block.includes('tgme_widget_message_pinned');

        // Photos (from post content, NOT profile)
        const photoBlocks = block.matchAll(/<a class="tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:\s*url\('([^']+)'\)/g);
        for (const ph of photoBlocks) {
            if (!isProfilePhoto(ph[1]) && !p.media.items.some(x => x.thumbnail === ph[1])) {
                p.media.items.push({
                    type: 'photo', post_id: p.post_id,
                    thumbnail: ph[1],
                    full_url: ph[1].replace(/thumb_\d+_/, '')
                });
            }
        }

        // Videos
        const vids = block.matchAll(/<video[^>]*src="([^"]+)"[^>]*>/g);
        for (const vi of vids) {
            if (!isProfilePhoto(vi[1])) p.media.items.push({ type: 'video', post_id: p.post_id, url: vi[1] });
        }

        // Documents
        const docs = block.matchAll(/<a class="tgme_widget_message_document_wrap[^"]*" href="([^"]+)"[^>]*>/g);
        for (const d of docs) {
            const item = { type: 'document', post_id: p.post_id, url: d[1] };
            const ti = block.match(/<div class="tgme_widget_message_document_title"[^>]*>([\s\S]*?)<\/div>/);
            if (ti) item.title = ti[1].replace(/<[^>]+>/g, '').trim();
            const sz = block.match(/<div class="tgme_widget_message_document_extra"[^>]*>([\d.]+ [KMGT]B)<\/div>/);
            if (sz) item.size = sz[1];
            p.media.items.push(item);
        }

        // CDN links (non-profile)
        const cdns = block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>]+/g);
        for (const c of cdns) {
            if (isProfilePhoto(c[0])) continue;
            if (p.media.items.some(x => JSON.stringify(x).includes(c[0]))) continue;
            let type = 'unknown';
            if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(c[0])) type = 'photo';
            else if (/\.(mp4|webm|avi|mov)(\?|$)/i.test(c[0])) type = 'video';
            else if (/\.(pdf|zip|rar|7z|apk|doc|docx|xls)(\?|$)/i.test(c[0])) type = 'document';
            p.media.items.push({ type, post_id: p.post_id, url: c[0] });
        }

        if (p.media.items.length) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length === 1 ? types[0] : 'mixed';
            if (p.media.items.filter(x => x.type === 'photo').length > 1 && p.media.type === 'photo') p.media.type = 'album';
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

        // Buttons
        const btns = [...block.matchAll(/<a class="tgme_widget_message_inline_button[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        p.buttons = btns.map(b => ({ text: b[2].replace(/<[^>]+>/g, '').trim(), url: b[1] }));

        p.hashtags = [...new Set([...block.matchAll(/#(\w+)/g)].map(m => m[1]))];
        p.mentions = [...new Set([...block.matchAll(/@(\w+)/g)].map(m => m[1]))];
        const lks = [...block.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
        p.links = [...new Set(lks.map(l => l[1]).filter(u => !u.includes('t.me') && !u.includes('telesco')))];
        p.emoji = [...new Set([...block.matchAll(/[\p{Emoji_Presentation}\u200D\uFE0F]/gu)].map(m => m[0]))];
        const reacts = [...block.matchAll(/<span class="tgme_widget_message_reaction_emoji"[^>]*>(.*?)<\/span>\s*<span class="tgme_widget_message_reaction_count"[^>]*>([^<]+)<\/span>/g)];
        p.reactions = reacts.map(r => ({ emoji: r[1].trim(), count: parseInt(r[2]) || 0 }));

        p.type = p.poll.has_poll ? 'poll' : p.media.type || (p.text ? 'text' : 'empty');
        posts.push(p);
    });

    return posts;
}

async function fetchLatestPosts(channel, count) {
    // Step 1: Fetch enough pages to cover 'count' posts
    // t.me/s/ shows NEWEST first per page (descending by post ID)
    
    let allPosts = [];
    let beforeId = null;
    let page = 1;
    const pagesNeeded = Math.ceil(count / 20);

    console.log(`📄 Need ~${pagesNeeded} page(s) for ${count} posts`);

    while (allPosts.length < count + 20) { // Fetch extra to be safe
        let url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(`https://t.me/s/${channel}`)}`;
        if (beforeId) {
            url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(`https://t.me/s/${channel}?before=${beforeId}`)}`;
        }

        console.log(`📥 Page ${page}${beforeId ? ` (before=${beforeId})` : ' (first/newest)'}`);

        let html;
        try {
            html = await fetchHTML(url);
        } catch (e) {
            console.log(`❌ ${e.message}`);
            break;
        }

        const posts = parsePosts(html);
        if (posts.length === 0) break;

        // Each page: newest to oldest within that page
        console.log(`   Got ${posts.length} posts: ${posts[0]?.post_id} → ${posts[posts.length-1]?.post_id}`);

        allPosts = allPosts.concat(posts);

        // Stop if we have enough
        if (allPosts.length >= count) break;

        // Next page: get older posts
        beforeId = posts[posts.length - 1]?.post_id?.split('/').pop();
        if (!beforeId) break;

        page++;
        await new Promise(r => setTimeout(r, 1500));
    }

    // CRITICAL: allPosts is currently [newest_on_page1, ..., oldest_on_page1, newest_on_page2, ..., oldest_on_page2]
    // We already know each page is newest→oldest
    // So the first element IS the newest post overall
    // Just take the first 'count' elements

    const result = allPosts.slice(0, count);

    console.log(`\n📊 RESULT (${result.length} posts):`);
    console.log(`   1st (newest): ${result[0]?.post_id}`);
    console.log(`   Last (oldest): ${result[result.length-1]?.post_id}`);

    return result;
}

// ============================================
// MAIN
// ============================================
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const count = parseInt(process.env.MAX_POSTS || '4');

    console.log(`\n🚀 Scraper | @${channel} | ${count} latest posts\n`);

    try {
        // 1. Fetch latest posts
        const posts = await fetchLatestPosts(channel, count);

        if (posts.length === 0) {
            console.log('❌ No posts');
            process.exit(1);
        }

        // 2. Process media
        let total = 0;
        posts.forEach(p => total += p.media.items.length);

        if (total > 0) {
            console.log(`\n📦 ${total} media items to process`);
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 ${post.post_id}`);
                    post.media.items = await processMedia(channel, post.media.items);
                }
            }
        }

        // 3. Filter & index
        const filtered = posts.filter(p => p.text || p.media.has_media || p.poll.has_poll);
        filtered.forEach((p, i) => p.index = i + 1);

        // 4. Save
        const dir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(filtered, null, 2));

        const dl = filtered.reduce((s, p) => s + p.media.items.filter(i => i.local_path).length, 0);
        console.log(`\n✅ ${filtered.length} posts | ${dl} files | ${path.join(dir, 'data.json')}`);

    } catch (e) {
        console.error('💥', e.message);
        process.exit(1);
    }
})();
