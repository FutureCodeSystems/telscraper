const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 90 * 1024 * 1024; // 90MB
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
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                getFileSize(res.headers.location).then(resolve);
                return;
            }
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
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
                return;
            }

            const contentType = response.headers['content-type'] || '';
            
            // Check if it's HTML instead of actual media
            if (contentType.includes('text/html') || contentType.includes('application/xml')) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                console.log(`  ⚠️ Got HTML instead of media, keeping remote URL only`);
                resolve(false);
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                // Verify file is not HTML
                const stat = fs.statSync(filepath);
                if (stat.size < 500) {
                    const content = fs.readFileSync(filepath, 'utf8');
                    if (content.includes('<!DOCTYPE') || content.includes('<html')) {
                        fs.unlinkSync(filepath);
                        console.log(`  ⚠️ File is HTML, removed`);
                        resolve(false);
                        return;
                    }
                }
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

function getDirectImageUrl(url) {
    // Extract direct image URL from CDN
    if (url.includes('telesco.pe/file/')) return url;
    if (url.includes('telesco.pe/file/thumb_')) {
        return url.replace(/thumb_\d+_/, '');
    }
    return url;
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

        let url = item.url || item.full_url || item.thumbnail || item.page_url;
        
        // Skip invalid URLs
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No valid URL' });
            continue;
        }

        // Get direct image URL for photos
        if (item.type === 'photo' && url.includes('t.me/')) {
            url = item.full_url || item.thumbnail || url;
        }

        url = getDirectImageUrl(url);

        console.log(`  📥 [${i+1}/${items.length}] ${url.substring(0, 80)}...`);

        // Check file size
        const size = await getFileSize(url);
        
        if (size === 0) {
            console.log(`  ⚠️ Could not determine size, trying download anyway...`);
            // Try to download anyway but with size check after
        }

        const MAX_SIZE = 90 * 1024 * 1024; // 90MB
        if (size > MAX_SIZE) {
            console.log(`  ⚠️ Large file (${(size/1024/1024).toFixed(1)}MB), linking only`);
            results.push({ ...item, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        const ext = getFileExtension(url, type);
        const postId = (item.post_id || 'unknown').replace(/[\/\\]/g, '_');
        const filename = `${postId}_${Date.now()}_${i}.${ext}`;
        const filepath = path.join(typeDir, filename);

        try {
            console.log(`  💾 Downloading ${size > 0 ? `(${(size/1024/1024).toFixed(1)}MB)` : ''}...`);
            const success = await downloadFile(url, filepath);

            if (success) {
                const repoUrl = process.env.GITHUB_REPOSITORY || 'user/repo';
                const branch = process.env.GITHUB_REF_NAME || 'main';
                const relativePath = filepath.replace(/\\/g, '/');
                const rawUrl = `https://raw.githubusercontent.com/${repoUrl}/${branch}/${relativePath}`;

                const finalSize = fs.statSync(filepath).size;
                results.push({ ...item, local_path: relativePath, raw_url: rawUrl, size_bytes: finalSize });
                console.log(`  ✅ Saved (${(finalSize/1024).toFixed(1)}KB)`);
            } else {
                results.push({ ...item, local_path: null, remote_url: url, error: 'Download returned HTML' });
                console.log(`  ⚠️ Skipped (got HTML instead of media)`);
            }
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

        // Extract photos with direct CDN URLs
        const photoPatterns = [
            /<a class="tgme_widget_message_photo_wrap[^"]*"(?: href="([^"]+)")?[^>]*style="[^"]*background-image:\s*url\('([^']+)'\)/g,
            /background-image:\s*url\('([^']+)'\)/g
        ];

        photoPatterns.forEach(pattern => {
            const matches = [...block.matchAll(pattern)];
            matches.forEach(m => {
                const url = m[2] || m[1];
                if (url && url.includes('telesco.pe')) {
                    if (!p.media.items.some(x => x.full_url === url || x.thumbnail === url)) {
                        p.media.items.push({
                            type: 'photo',
                            post_id: p.post_id,
                            thumbnail: url,
                            full_url: url.replace(/thumb_\d+_/, '')
                        });
                    }
                }
            });
        });

        // Extract videos with direct CDN URLs
        const videos = [...block.matchAll(/<video[^>]*src="([^"]+)"[^>]*>/g)];
        videos.forEach(vi => {
            if (vi[1].includes('telesco.pe')) {
                p.media.items.push({ type: 'video', post_id: p.post_id, url: vi[1] });
            }
        });

        // Extract documents
        const docs = [...block.matchAll(/<a class="tgme_widget_message_document_wrap[^"]*" href="([^"]+)"[^>]*>/g)];
        docs.forEach(d => {
            const item = { type: 'document', post_id: p.post_id, url: d[1] };
            const ti = block.match(/<div class="tgme_widget_message_document_title"[^>]*>([\s\S]*?)<\/div>/);
            if (ti) item.title = ti[1].replace(/<[^>]+>/g, '').trim();
            const sz = block.match(/<div class="tgme_widget_message_document_extra"[^>]*>([\d.]+ [KMGT]B)<\/div>/);
            if (sz) item.size = sz[1];
            p.media.items.push(item);
        });

        // Extract all CDN URLs
        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>]+/g)];
        cdns.forEach(c => {
            const url = c[0];
            if (!p.media.items.some(x => {
                return JSON.stringify(x).includes(url) || 
                       (x.full_url && x.full_url === url) ||
                       (x.thumbnail && x.thumbnail === url);
            })) {
                // Determine type by extension
                let type = 'unknown';
                if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url)) type = 'photo';
                else if (/\.(mp4|webm|avi|mov|mkv)(\?|$)/i.test(url)) type = 'video';
                else if (/\.(mp3|ogg|wav)(\?|$)/i.test(url)) type = 'audio';
                else if (/\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|apk|exe)(\?|$)/i.test(url)) type = 'document';
                
                p.media.items.push({ type, post_id: p.post_id, url: url });
            }
        });

        if (p.media.items.length > 0) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length > 1 ? 'mixed' : types[0];
            const photoCount = p.media.items.filter(x => x.type === 'photo').length;
            if (photoCount > 1 && p.media.type === 'photo') p.media.type = 'album';
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

    console.log(`🎯 Target: ${maxPosts} LATEST posts from @${channel}`);

    while (allPosts.length < maxPosts) {
        let url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://t.me/s/${channel}`)}`;
        if (beforeId) {
            url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://t.me/s/${channel}?before=${beforeId}`)}`;
        }

        console.log(`📄 Fetching page ${page}${beforeId ? ` (before post ${beforeId})` : ' (latest)'}...`);

        let html;
        try {
            html = await fetchHTML(url);
        } catch (e) {
            console.log(`❌ Failed: ${e.message}`);
            break;
        }

        const posts = parsePosts(html, channel);

        if (posts.length === 0) {
            console.log('🏁 No more posts');
            break;
        }

        console.log(`   Got ${posts.length} posts`);

        // First page = newest posts
        // They're already in correct order (newest first) from t.me/s/
        allPosts = allPosts.concat(posts);
        console.log(`   Total: ${allPosts.length}/${maxPosts}`);

        if (allPosts.length >= maxPosts) break;

        // Get oldest post ID from this page for next page
        const oldestPost = posts[posts.length - 1];
        if (oldestPost && oldestPost.post_id) {
            beforeId = oldestPost.post_id.split('/').pop();
        } else {
            break;
        }

        page++;
        await new Promise(r => setTimeout(r, 1000));
    }

    // Trim to max and reverse so oldest first, newest last
    const result = allPosts.slice(0, maxPosts);
    
    return result;
}

// Main
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '5');

    console.log(`\n🚀 Telegram Scraper v2`);
    console.log(`📺 @${channel} | 📊 ${maxPosts} latest posts\n`);

    try {
        // Fetch
        const posts = await fetchAllPosts(channel, maxPosts);

        if (posts.length === 0) {
            console.log('❌ No posts found!');
            process.exit(1);
        }

        // Process media
        let totalMedia = 0;
        posts.forEach(p => totalMedia += p.media.items.length);

        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 Post #${post.post_id} (${post.media.items.length} items)`);
                    post.media.items = await processMedia(channel, post.media.items);
                }
            }
        }

        // Filter and sort (newest first by default from API)
        const filtered = posts.filter(p => p.type !== 'empty' || p.text);

        // Assign indexes (1 = newest post)
        filtered.forEach((p, i) => p.index = i + 1);

        // Save
        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });

        const dataPath = path.join(channelDir, 'data.json');
        fs.writeFileSync(dataPath, JSON.stringify(filtered, null, 2));

        const downloadedCount = filtered.reduce((sum, p) => 
            sum + p.media.items.filter(i => i.local_path).length, 0);

        console.log(`\n✅ Done!`);
        console.log(`   Posts: ${filtered.length}`);
        console.log(`   Downloaded: ${downloadedCount} files`);
        console.log(`   Saved: ${dataPath}`);

    } catch (error) {
        console.error('❌ Fatal:', error.message);
        process.exit(1);
    }
})();
