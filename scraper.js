const https = require('https');

async function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
    });
}

async function getPosts(channel) {
    const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(`https://t.me/s/${channel}`)}`;
    const html = await fetchHTML(proxyUrl);
    
    const posts = [];
    const blocks = html.split(/<div class="tgme_widget_message_wrap[^"]*">/);
    blocks.shift();
    
    blocks.forEach((block, i) => {
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
        
        p.index = i + 1;
        
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
        photos.forEach(ph => p.media.items.push({ type: 'photo', page_url: ph[1] || null, thumbnail: ph[2] || null, full_url: (ph[1] || ph[2] || '').replace(/thumb_\d+_/, '') }));
        
        const videos = [...block.matchAll(/<video[^>]*src="([^"]+)"[^>]*>/g)];
        videos.forEach(vi => p.media.items.push({ type: 'video', url: vi[1] }));
        
        const docs = [...block.matchAll(/<a class="tgme_widget_message_document_wrap[^"]*" href="([^"]+)"[^>]*>/g)];
        docs.forEach(d => {
            const item = { type: 'document', url: d[1] };
            const ti = block.match(/<div class="tgme_widget_message_document_title"[^>]*>([\s\S]*?)<\/div>/);
            if (ti) item.title = ti[1].replace(/<[^>]+>/g, '').trim();
            const sz = block.match(/<div class="tgme_widget_message_document_extra"[^>]*>([\d.]+ [KMGT]B)<\/div>/);
            if (sz) item.size = sz[1];
            p.media.items.push(item);
        });
        
        const cdns = [...block.matchAll(/https:\/\/cdn\d+\.telesco\.pe\/[^\s"'<>]+/g)];
        cdns.forEach(c => {
            if (!p.media.items.some(x => JSON.stringify(x).includes(c[0]))) p.media.items.push({ type: 'unknown', url: c[0] });
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
    
    return posts.filter(p => p.type !== 'empty' || p.text);
}

const CHANNEL = process.env.CHANNEL || 'devefun';

getPosts(CHANNEL).then(posts => {
    const output = JSON.stringify(posts, null, 2);
    require('fs').writeFileSync('data.json', output);
    console.log(`✅ ${posts.length} posts saved to data.json`);
});
