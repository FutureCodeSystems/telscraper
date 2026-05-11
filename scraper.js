const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== Config ==========
const MAX_FILE_SIZE = 90 * 1024 * 1024; // 90 MB
const BASE_DIR = 'channels';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQUEST_DELAY_MS = 1500; // delay between requests to avoid rate limiting
const MAX_POSTS_PER_PAGE = 40; // telegram default

// ========== Helper: fetch with retry and cookie jar ==========
class SimpleCookieJar {
    constructor() { this.cookies = {}; }
    setFromHeaders(headers) {
        const setCookie = headers['set-cookie'];
        if (setCookie) {
            const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
            for (let cookie of cookies) {
                const match = cookie.match(/^([^=]+)=([^;]+)/);
                if (match) this.cookies[match[1]] = match[2];
            }
        }
    }
    getHeader() {
        return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

async function fetchHTML(url, retries = 3, delay = 2000, cookieJar = null) {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        }
    };
    if (cookieJar) {
        const cookieHeader = cookieJar.getHeader();
        if (cookieHeader) options.headers['Cookie'] = cookieHeader;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await new Promise((resolve, reject) => {
                const req = protocol.get(url, options, (res) => {
                    // handle redirect
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const redirectUrl = res.headers.location;
                        if (cookieJar) cookieJar.setFromHeaders(res.headers);
                        fetchHTML(redirectUrl, retries, delay, cookieJar).then(resolve).catch(reject);
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (cookieJar) cookieJar.setFromHeaders(res.headers);
                        resolve(data);
                    });
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.setTimeout(30000, () => {
                    req.destroy();
                    reject(new Error('Timeout'));
                });
                req.end();
            });
            return response;
        } catch (err) {
            if (attempt === retries) {
                // fallback to allorigins proxy
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
                try {
                    const proxyData = await fetchHTML(proxyUrl, 1, 0);
                    return proxyData;
                } catch (e) {
                    throw new Error(`Failed to fetch ${url}: ${err.message}`);
                }
            }
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ========== Get file size ==========
async function getFileSize(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.request(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } }, (res) => {
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

// ========== Download file with content-type detection ==========
async function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);
        let contentType = null;

        protocol.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
                return;
            }

            contentType = response.headers['content-type'] || '';
            if (contentType.includes('text/html') && !contentType.includes('image/')) {
                file.close();
                try { fs.unlinkSync(filepath); } catch (e) {}
                resolve(false);
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                // Additional check: if file is very small and contains HTML
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

// ========== Determine media type from URL and content-type ==========
function getMediaType(url, contentType) {
    if (contentType) {
        if (contentType.startsWith('image/')) return 'photo';
        if (contentType.startsWith('video/')) return 'video';
        if (contentType.startsWith('audio/')) return 'audio';
        if (contentType.includes('application/')) return 'document';
    }
    const ext = path.extname(url).toLowerCase();
    if (['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)) return 'photo';
    if (['.mp4','.webm','.mov','.mkv'].includes(ext)) return 'video';
    if (['.mp3','.ogg','.wav','.m4a'].includes(ext)) return 'audio';
    if (['.pdf','.zip','.rar','.apk','.doc','.docx','.xls','.xlsx'].includes(ext)) return 'document';
    return 'document';
}

// ========== Process media items (download or link) ==========
async function processMedia(channel, items, channelInfo) {
    const mediaDir = path.join(BASE_DIR, channel, 'media');
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let url = item.full_url || item.url || item.thumbnail;
        if (!url || !url.startsWith('http')) {
            results.push({ ...item, local_path: null, error: 'No URL' });
            continue;
        }

        console.log(`  📥 [${i+1}/${items.length}] ${url.substring(0, 80)}...`);

        const size = await getFileSize(url);
        const contentType = await getContentType(url); // helper below
        const mediaType = getMediaType(url, contentType);

        // If file is too large, store remote_url only
        if (size > MAX_FILE_SIZE) {
            console.log(`  ⚠️ Large (${(size/1024/1024).toFixed(1)}MB), remote only`);
            results.push({ ...item, type: mediaType, local_path: null, remote_url: url, size_bytes: size });
            continue;
        }

        // Determine file extension
        let ext = '';
        if (mediaType === 'photo') ext = 'jpg';
        else if (mediaType === 'video') ext = 'mp4';
        else if (mediaType === 'audio') ext = 'mp3';
        else ext = 'bin';

        const postId = (item.post_id || 'p').replace(/[\/\\:]/g, '_');
        const filename = `${postId}_${i}.${ext}`;
        const typeDir = path.join(mediaDir, mediaType);
        if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });
        const filepath = path.join(typeDir, filename);

        try {
            const success = await downloadFile(url, filepath);
            if (success) {
                const repoUrl = process.env.GITHUB_REPOSITORY || 'user/repo';
                const branch = process.env.GITHUB_REF_NAME || 'main';
                const rawUrl = `https://raw.githubusercontent.com/${repoUrl}/${branch}/${filepath.replace(/\\/g, '/')}`;
                results.push({ ...item, type: mediaType, local_path: filepath.replace(/\\/g, '/'), raw_url: rawUrl, size_bytes: fs.statSync(filepath).size });
                console.log(`  ✅`);
            } else {
                results.push({ ...item, type: mediaType, local_path: null, remote_url: url, error: 'Not media' });
            }
        } catch (err) {
            results.push({ ...item, type: mediaType, local_path: null, remote_url: url, error: err.message });
        }
        await new Promise(r => setTimeout(r, 200)); // small delay between downloads
    }
    return results;
}

async function getContentType(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.request(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                getContentType(res.headers.location).then(resolve);
                return;
            }
            resolve(res.headers['content-type'] || '');
        });
        req.on('error', () => resolve(''));
        req.setTimeout(5000, () => { req.destroy(); resolve(''); });
        req.end();
    });
}

// ========== Parse a single post from embed HTML ==========
function parseSinglePost(html, channel, postNum) {
    const postId = `${channel}/${postNum}`;
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
    const t = html.match(/<time[^>]*datetime="([^"]+)"/);
    if (t) { p.date = t[1]; p.date_unix = new Date(t[1]).getTime() / 1000; }

    // Text
    const txt = html.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (txt) {
        p.text_html = txt[1].trim();
        p.text = txt[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    }

    // Views
    const v = html.match(/<span class="tgme_widget_message_views"[^>]*>([\d.]+[KM]?)/);
    if (v) {
        p.views_raw = v[1];
        let n = parseFloat(v[1].replace(/,/g, '.'));
        p.views = v[1].includes('K') ? Math.round(n * 1000) : v[1].includes('M') ? Math.round(n * 1000000) : Math.round(n);
    }

    // Media items (cdn.telesco.pe)
    const cdns = [...html.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
    const seen = new Set();
    for (const c of cdns) {
        let url = c[0].replace(/[)"']+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        // Temporary type detection by URL pattern
        let type = 'photo';
        if (/\.(mp4|webm)(\?|$)/i.test(url)) type = 'video';
        else if (/\.(pdf|zip|rar|apk)(\?|$)/i.test(url)) type = 'document';
        p.media.items.push({ type, post_id: postId, url, full_url: url.replace(/thumb_\d+_/, ''), thumbnail: url.includes('/thumb_') ? url : null });
    }

    if (p.media.items.length > 0) {
        p.media.has_media = true;
        const types = [...new Set(p.media.items.map(x => x.type))];
        p.media.type = types.length > 1 ? 'mixed' : types[0];
        if (p.media.items.filter(x => x.type === 'photo').length > 1 && p.media.type === 'photo') p.media.type = 'album';
    }

    if (p.text) p.type = 'text';
    else if (p.media.has_media) p.type = p.media.type;
    else p.type = 'empty';

    return p;
}

// ========== Parse multiple posts from main page ==========
function parsePosts(html, channel) {
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

        // Date
        const t = block.match(/<time[^>]*datetime="([^"]+)"/);
        if (t) { p.date = t[1]; p.date_unix = new Date(t[1]).getTime() / 1000; }

        // Edit date: look for <span class="tgme_widget_message_edit_date">
        const editSpan = block.match(/<span class="tgme_widget_message_edit_date"[^>]*>.*?<time[^>]*datetime="([^"]+)"/);
        if (editSpan) {
            p.edit_date = editSpan[1];
            p.edit_date_unix = new Date(editSpan[1]).getTime() / 1000;
            p.is_edited = true;
        }

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
            let n = parseFloat(v[1].replace(/,/g, '.'));
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

        // Media items
        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>)]+/g)];
        const seen = new Set();
        for (const c of cdns) {
            let url = c[0].replace(/[)"']+$/, '');
            if (seen.has(url)) continue;
            seen.add(url);
            let type = 'photo';
            if (/\.(mp4|webm)(\?|$)/i.test(url)) type = 'video';
            else if (/\.(pdf|zip|rar|apk)(\?|$)/i.test(url)) type = 'document';
            p.media.items.push({ type, post_id: postId, url, full_url: url.replace(/thumb_\d+_/, ''), thumbnail: url.includes('/thumb_') ? url : null });
        }

        if (p.media.items.length > 0) {
            p.media.has_media = true;
            const types = [...new Set(p.media.items.map(x => x.type))];
            p.media.type = types.length > 1 ? 'mixed' : types[0];
            if (p.media.items.filter(x => x.type === 'photo').length > 1 && p.media.type === 'photo') p.media.type = 'album';
        }

        // Poll
        if (block.includes('<div class="tgme_widget_message_poll')) {
            p.poll.has_poll = true;
            const q = block.match(/<div class="tgme_widget_message_poll_question"[^>]*>(.*?)<\/div>/);
            if (q) p.poll.question = q[1].replace(/<[^>]+>/g, '').trim();
            const opts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_text[^"]*">(.*?)<\/span>/g)];
            const pcts = [...block.matchAll(/<span class="tgme_widget_message_poll_option_percent[^"]*">([^<]+)<\/span>/g)];
            opts.forEach((o, j) => p.poll.options.push({ index: j+1, text: o[1].replace(/<[^>]+>/g, '').trim(), percent: pcts[j] ? parseFloat(pcts[j][1]) : null }));
            const vts = block.match(/<div class="tgme_widget_message_poll_votes"[^>]*>([^<]+)<\/div>/);
            if (vts) p.poll.total_votes = vts[1].trim();
            p.poll.is_anonymous = !block.includes('tgme_widget_message_poll_type_visible');
            p.poll.is_closed = block.includes('tgme_widget_message_poll_closed');
        }

        // Buttons
        const btns = [...block.matchAll(/<a class="tgme_widget_message_inline_button[^"]*" href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        p.buttons = btns.map(b => ({ text: b[2].replace(/<[^>]+>/g, '').trim(), url: b[1] }));

        // Hashtags, mentions, links, emoji
        p.hashtags = [...new Set([...block.matchAll(/#(\w+)/g)].map(m => m[1]))];
        p.mentions = [...new Set([...block.matchAll(/@(\w+)/g)].map(m => m[1]))];
        const lks = [...block.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
        p.links = [...new Set(lks.map(l => l[1]).filter(u => !u.includes('t.me/') && !u.includes('telesco.pe')))];
        p.emoji = [...new Set([...block.matchAll(/[\p{Emoji_Presentation}\u200D\uFE0F]/gu)].map(m => m[0]))];

        // Reactions
        const reacts = [...block.matchAll(/<span class="tgme_widget_message_reaction_emoji"[^>]*>(.*?)<\/span>\s*<span class="tgme_widget_message_reaction_count"[^>]*>([^<]+)<\/span>/g)];
        p.reactions = reacts.map(r => ({ emoji: r[1].trim(), count: parseInt(r[2]) || 0 }));

        // Determine post type
        if (p.poll.has_poll) p.type = 'poll';
        else if (p.media.type === 'album') p.type = 'album';
        else if (p.media.type === 'photo') p.type = 'photo';
        else if (p.media.type === 'video') p.type = 'video';
        else if (p.media.type === 'document') p.type = 'document';
        else if (p.text) p.type = 'text';
        else p.type = 'media_only';

        posts.push(p);
    }
    return posts;
}

// ========== Fetch channel avatar from main page ==========
async function fetchChannelAvatar(channel, cookieJar) {
    try {
        const html = await fetchHTML(`https://t.me/${channel}`, 2, 2000, cookieJar);
        const imgMatch = html.match(/<img class="tgme_page_photo_image"[^>]*src="([^"]+)"/);
        if (imgMatch) {
            let avatarUrl = imgMatch[1];
            if (avatarUrl.startsWith('//')) avatarUrl = 'https:' + avatarUrl;
            return avatarUrl;
        }
        return null;
    } catch (err) {
        console.log(`  ⚠️ Could not fetch avatar: ${err.message}`);
        return null;
    }
}

// ========== Fetch posts with pagination and new posts detection ==========
async function fetchPosts(channel, maxPosts) {
    let allPosts = [];
    let currentMaxId = 0;
    let cookieJar = new SimpleCookieJar();

    console.log(`🎯 Getting up to ${maxPosts} latest posts from @${channel}`);

    // First, get main page (first ~40 posts)
    const mainHtml = await fetchHTML(`https://t.me/s/${channel}`, 3, 2000, cookieJar);
    if (!mainHtml || mainHtml.length < 500) {
        throw new Error('Empty response from main page');
    }

    let posts = parsePosts(mainHtml, channel);
    console.log(`📄 Page 1: ${posts.length} posts`);

    allPosts = allPosts.concat(posts);

    // Determine highest post ID from first page
    for (const p of allPosts) {
        const num = parseInt(p.post_id.split('/').pop());
        if (!isNaN(num) && num > currentMaxId) currentMaxId = num;
    }
    console.log(`   Highest ID on page: ${currentMaxId}`);

    // Now we need to fetch any posts newer than the ones we have.
    // Instead of assuming sequential, we will check from currentMaxId+1 upwards
    // until we find a gap of 3 consecutive missing posts.
    let missingCount = 0;
    let fetchCount = 0;
    let nextId = currentMaxId + 1;

    while (fetchCount < maxPosts && missingCount < 3) {
        const testId = nextId;
        console.log(`   Checking: ${channel}/${testId}...`);
        const embedHtml = await fetchHTML(`https://t.me/${channel}/${testId}?embed=1`, 2, 1000, cookieJar);
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

        if (embedHtml && (embedHtml.includes('tgme_widget_message') || embedHtml.includes('data-post'))) {
            const newPost = parseSinglePost(embedHtml, channel, testId);
            if (newPost && newPost.post_id) {
                allPosts.unshift(newPost);
                fetchCount++;
                console.log(`   ✅ Found: ${channel}/${testId}`);
                missingCount = 0;
                currentMaxId = testId;
            } else {
                missingCount++;
                console.log(`   ❌ Not found (${missingCount}/3)`);
            }
        } else {
            missingCount++;
            console.log(`   ❌ Not found (${missingCount}/3)`);
        }
        nextId++;
        if (fetchCount >= maxPosts) break;
    }

    // Now we have all posts (both from main page and newer ones). Sort by post number descending
    allPosts.sort((a, b) => {
        const aNum = parseInt(a.post_id.split('/').pop()) || 0;
        const bNum = parseInt(b.post_id.split('/').pop()) || 0;
        return bNum - aNum;
    });

    // Deduplicate by post_id
    const seen = new Set();
    const unique = allPosts.filter(p => {
        if (seen.has(p.post_id)) return false;
        seen.add(p.post_id);
        return true;
    });

    const result = unique.slice(0, maxPosts);
    console.log(`\n📊 Final (${result.length} posts):`);
    result.forEach((p, i) => console.log(`   ${i+1}. ${p.post_id} [${p.type}]`));
    return result;
}

// ========== Main ==========
(async () => {
    const channel = process.env.CHANNEL || 'devefun';
    const maxPosts = parseInt(process.env.MAX_POSTS || '20');

    console.log(`\n🚀 Telegram Scraper v10 (Fixed)`);
    console.log(`📺 @${channel} | 📊 ${maxPosts} latest posts\n`);

    try {
        // Create cookie jar and fetch channel avatar
        const cookieJar = new SimpleCookieJar();
        const avatarUrl = await fetchChannelAvatar(channel, cookieJar);

        // Save channel info
        const channelDir = path.join(BASE_DIR, channel);
        if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir, { recursive: true });
        const channelInfoPath = path.join(channelDir, 'channel.json');
        const channelInfo = { id: channel, name: null, avatar: avatarUrl, last_update: new Date().toISOString() };
        fs.writeFileSync(channelInfoPath, JSON.stringify(channelInfo, null, 2));

        // Fetch posts
        const posts = await fetchPosts(channel, maxPosts);
        if (posts.length === 0) {
            console.log('❌ No posts found');
            process.exit(0);
        }

        // Process media (download files)
        let totalMedia = 0;
        for (const p of posts) totalMedia += p.media.items.length;
        if (totalMedia > 0) {
            console.log(`\n📦 Processing ${totalMedia} media items...`);
            for (const post of posts) {
                if (post.media.items.length > 0) {
                    console.log(`\n📝 ${post.post_id} (${post.media.items.length} items)`);
                    post.media.items = await processMedia(channel, post.media.items, channelInfo);
                }
            }
        }

        // Assign indexes (1 = newest)
        posts.forEach((p, i) => p.index = i + 1);

        // Save data.json
        const dataPath = path.join(channelDir, 'data.json');
        fs.writeFileSync(dataPath, JSON.stringify(posts, null, 2));

        // Stats
        const downloaded = posts.reduce((s, p) => s + p.media.items.filter(i => i.local_path).length, 0);
        const skipped = posts.reduce((s, p) => s + p.media.items.filter(i => !i.local_path && i.remote_url).length, 0);

        console.log(`\n✅ Done!`);
        console.log(`   💾 Saved: ${dataPath}`);
        console.log(`   📰 Posts: ${posts.length}`);
        console.log(`   📥 Downloaded: ${downloaded} files`);
        console.log(`   🔗 Remote only: ${skipped} files`);
        console.log(`   🖼️ Avatar: ${avatarUrl || 'none'}`);
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
})();
