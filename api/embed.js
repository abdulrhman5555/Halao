// api/embed.js
// Vercel Serverless Function
// يبحث عن أنمي في Anikoto API بالاسم، ثم يرجع رابط embed للحلقة المطلوبة

const ANIKOTO_BASE = 'https://anikotoapi.site';
const MAX_PAGES_TO_SEARCH = 15; // حد أقصى للصفحات قبل التوقف (تجنب تجاوز الـ rate limit)
const PER_PAGE = 50;

// تنظيف النص للمقارنة (lowercase, إزالة رموز خاصة)
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// يفحص إن كانت كل العناوين المحتملة تحتوي تطابق مع العنوان المطلوب
function titleMatches(entry, target) {
  const targetNorm = normalize(target);
  if (!targetNorm) return false;

  const candidates = [
    entry.title,
    entry.alternative,
    entry.native,
    entry.titles
  ].filter(Boolean);

  for (const c of candidates) {
    const cNorm = normalize(c);
    if (!cNorm) continue;
    if (cNorm === targetNorm) return true;
    if (cNorm.includes(targetNorm) || targetNorm.includes(cNorm)) return true;
  }
  return false;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (HalaApp)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// يبحث عن الأنمي بالاسم أو mal_id عبر صفحات /recent-anime
async function findAnimeEntry({ malId, title }) {
  for (let page = 1; page <= MAX_PAGES_TO_SEARCH; page++) {
    let data;
    try {
      data = await fetchJson(`${ANIKOTO_BASE}/recent-anime?page=${page}&per_page=${PER_PAGE}`);
    } catch (e) {
      break; // وقف البحث عند أي خطأ شبكة/rate-limit
    }

    if (!data || !Array.isArray(data.data) || data.data.length === 0) break;

    // أولاً: تطابق mal_id (أدق وأسرع)
    if (malId) {
      const byMal = data.data.find(a => String(a.mal_id) === String(malId));
      if (byMal) return byMal;
    }

    // ثانياً: تطابق الاسم
    if (title) {
      const byTitle = data.data.find(a => titleMatches(a, title));
      if (byTitle) return byTitle;
    }

    // إذا كانت هذه آخر صفحة فعلياً
    if (data.pagination && page >= data.pagination.total_pages) break;
  }
  return null;
}

// يجلب تفاصيل المسلسل ويستخرج embed للحلقة المطلوبة
async function getEpisodeEmbed(anikotoId, episodeNumber) {
  const data = await fetchJson(`${ANIKOTO_BASE}/series/${anikotoId}`);
  if (!data || !Array.isArray(data.episodes)) return null;

  // محاولة إيجاد الحلقة بالرقم المطلوب
  let ep = data.episodes.find(e =>
    Number(e.number) === Number(episodeNumber) ||
    Number(e.episode_number) === Number(episodeNumber)
  );

  // إن لم توجد، جرب أول حلقة كحل أخير
  if (!ep && data.episodes.length > 0) {
    ep = data.episodes[0];
  }

  if (!ep) return null;

  return {
    sub: ep.embed_url?.sub || null,
    dub: ep.embed_url?.dub || null,
    episode_embed_id: ep.episode_embed_id || null,
    matchedEpisode: ep.number ?? ep.episode_number ?? null,
    totalEpisodes: data.episodes.length
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { mal_id, title, episode } = req.query;
    const ep = episode ? Number(episode) : 1;

    if (!mal_id && !title) {
      return res.status(400).json({ found: false, error: 'mal_id أو title مطلوب' });
    }

    const entry = await findAnimeEntry({ malId: mal_id, title });

    if (!entry) {
      return res.status(200).json({
        found: false,
        reason: 'not_in_library',
        message: 'هذا الأنمي غير متوفر في المكتبة حالياً'
      });
    }

    const embedData = await getEpisodeEmbed(entry.id, ep);

    if (!embedData || (!embedData.sub && !embedData.dub)) {
      return res.status(200).json({
        found: false,
        reason: 'no_embed',
        message: 'الحلقة المطلوبة غير متوفرة',
        anime_title: entry.title
      });
    }

    return res.status(200).json({
      found: true,
      anime_title: entry.title,
      anikoto_id: entry.id,
      requested_episode: ep,
      matched_episode: embedData.matchedEpisode,
      total_episodes: embedData.totalEpisodes,
      embed: {
        sub: embedData.sub,
        dub: embedData.dub
      }
    });

  } catch (err) {
    return res.status(500).json({ found: false, error: 'server_error', message: String(err) });
  }
      }
