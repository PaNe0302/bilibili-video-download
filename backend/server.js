const express = require('express');
const axios = require('axios');

const app = express();

// Middleware hỗ trợ CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// API chính
app.get('/api/video', async (req, res) => {
  const { url, sessdata } = req.query;

  if (!url || !url.includes('bilibili.com')) {
    return res.status(400).json({ error: 'URL không hợp lệ' });
  }

  try {
    // Trích xuất bvid từ URL
    const bvidMatch = url.match(/BV[0-9A-Za-z]{10}/);
    if (!bvidMatch) throw new Error('Không tìm thấy bvid trong URL');
    const bvid = bvidMatch[0];

    // Gọi API Bilibili để lấy cid
    const infoRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid= ${bvid}`, {
      headers: {
        'Cookie': `SESSDATA=${sessdata}`
      }
    });

    const cid = infoRes.data.data.cid;

    // Các độ phân giải ưu tiên
    const QUALITIES = [
      { qn: 120, label: '4K HDR' },
      { qn: 112, label: '1080P+60fps' },
      { qn: 80, label: '1080P' },
      { qn: 64, label: '720P' },
      { qn: 32, label: '480P' }
    ];

    let bestFormat = null;

    for (const quality of QUALITIES) {
      const playUrl = `https://api.bilibili.com/x/player/playurl?bvid= ${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`;
      try {
        const playRes = await axios.get(playUrl, {
          headers: {
            Cookie: `SESSDATA=${sessdata}`
          }
        });

        if (playRes.data.code === 0 && playRes.data.data.dash?.video.length > 0) {
          bestFormat = {
            quality: quality.label,
            size: (playRes.data.data.dash.video[0].bandwidth / 1024 / 1024).toFixed(2) + ' MB',
            link: playRes.data.data.dash.video[0].baseUrl
          };
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!bestFormat) {
      return res.status(403).json({ error: 'Không thể tải video với SESSDATA này' });
    }

    res.json({
      title: infoRes.data.data.title,
      thumbnail: infoRes.data.data.pic,
      format: bestFormat
    });

  } catch (err) {
    console.error(err.message);
    if (err.response?.status === 403 || err.message.includes('403')) {
      return res.status(403).json({ error: 'Cookie hết hạn hoặc không hợp lệ' });
    }
    res.status(500).json({ error: 'Lỗi khi xử lý yêu cầu' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
});