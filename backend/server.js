const express = require('express');
const axios = require('axios');

const app = express();

// Middleware hỗ trợ CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // Giữ nguyên theo yêu cầu
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Hàm helper để gọi API Bilibili với SESSDATA
async function callBilibiliAPI(apiUrl, sessdata) {
  try {
    const response = await axios.get(apiUrl, {
      headers: {
        'Cookie': `SESSDATA=${sessdata}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' // Thêm User-Agent để giả lập trình duyệt
      }
    });
    return response.data;
  } catch (error) {
    // Ném lỗi để hàm gọi có thể xử lý
    if (error.response) {
      // Lỗi từ phía server Bilibili (ví dụ: 403, 404)
      const apiError = new Error(`Lỗi từ API Bilibili (${error.response.status}): ${apiUrl}`);
      apiError.status = error.response.status;
      apiError.data = error.response.data;
      throw apiError;
    } else if (error.request) {
      // Yêu cầu đã được gửi nhưng không nhận được phản hồi
      throw new Error(`Không nhận được phản hồi từ API Bilibili: ${apiUrl}`);
    } else {
      // Lỗi khi thiết lập yêu cầu
      throw new Error(`Lỗi khi thiết lập yêu cầu đến API Bilibili: ${error.message}`);
    }
  }
}

// API chính
app.get('/api/video', async (req, res) => {
  const { url, sessdata } = req.query;

  if (!url || !url.includes('bilibili.com')) {
    return res.status(400).json({ error: 'URL không hợp lệ. Phải là video từ bilibili.com' });
  }

  if (!sessdata) {
    return res.status(400).json({ error: 'SESSDATA là bắt buộc.' });
  }

  try {
    // Trích xuất bvid từ URL
    const bvidMatch = url.match(/BV[A-Za-z0-9]{10}/);
    if (!bvidMatch) {
      return res.status(400).json({ error: 'Không tìm thấy bvid hợp lệ trong URL' });
    }
    const bvid = bvidMatch[0];

    // Gọi API Bilibili để lấy cid
    const viewApiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`; // Sửa: bỏ khoảng trắng
    const infoData = await callBilibiliAPI(viewApiUrl, sessdata);

    if (infoData.code !== 0 || !infoData.data || !infoData.data.cid) {
      console.error('Lỗi lấy cid:', infoData);
      return res.status(500).json({ error: `Không thể lấy thông tin video (cid). Mã lỗi: ${infoData.code}. Message: ${infoData.message || 'Không có message'}` });
    }
    const cid = infoData.data.cid;
    const videoTitle = infoData.data.title;
    const videoThumbnail = infoData.data.pic;

    // Các độ phân giải ưu tiên
    const QUALITIES = [
      { qn: 120, label: '4K HDR' }, // fnval=16 for DASH
      { qn: 116, label: '1080P 60fps (HEVC)'}, // fnval=16 for DASH
      { qn: 112, label: '1080P+ (HDR)' }, // fnval=16 for DASH, possibly higher bitrate 1080p
      { qn: 80, label: '1080P' },   // fnval=16 for DASH
      { qn: 74, label: '720P 60fps (HEVC)'}, // fnval=16 for DASH
      { qn: 64, label: '720P' },    // fnval=16 for DASH
      { qn: 32, label: '480P' },    // fnval=16 for DASH
      { qn: 16, label: '360P' }     // fnval=16 for DASH
    ];

    let bestFormat = null;

    for (const quality of QUALITIES) {
      const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`; // Sửa: bỏ khoảng trắng
      try {
        const playData = await callBilibiliAPI(playUrlApi, sessdata);

        if (playData.code === 0 && playData.data?.dash?.video?.length > 0) {
          const videoStream = playData.data.dash.video[0];
          // Ưu tiên baseUrl nếu có, nếu không thì backup_url[0]
          const downloadLink = videoStream.baseUrl || (videoStream.backupUrl && videoStream.backupUrl[0]); 
          
          if(downloadLink){
            bestFormat = {
              quality: quality.label,
              // Kích thước dựa trên 'size' nếu có, nếu không thì dùng 'bandwidth' (coi như bytes/s) và ước tính thời lượng (cần cải thiện)
              // Hiện tại, API playurl với DASH không trả trực tiếp size file, chỉ có bandwidth.
              // Để đơn giản, ta vẫn dùng bandwidth như trước, hoặc có thể bỏ thông tin size nếu không chính xác.
              // Hoặc có thể tìm hiểu thêm API khác để lấy size chính xác.
              size: videoStream.bandwidth ? (videoStream.bandwidth * (infoData.data.duration || 300) / 8 / 1024 / 1024).toFixed(2) + ' MB (ước tính)' : 'Không rõ',
              link: downloadLink
            };
            console.log(`Tìm thấy chất lượng ${quality.label} cho bvid ${bvid}`);
            break; // Tìm thấy chất lượng tốt nhất, thoát vòng lặp
          }
        } else {
           console.warn(`Không có luồng video DASH cho chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}. Code: ${playData.code}, Message: ${playData.message}`);
        }
      } catch (e) {
        // Log lỗi chi tiết khi gọi API cho một chất lượng cụ thể
        console.error(`Lỗi khi lấy playurl cho chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}:`, e.message, e.status ? `Status: ${e.status}` : '');
        if (e.status === 403) {
          // Nếu lỗi 403 cụ thể ở đây, có thể SESSDATA không đủ quyền cho chất lượng này
          console.warn(`SESSDATA có thể không đủ quyền cho chất lượng ${quality.label} (qn: ${quality.qn})`);
        }
        // Tiếp tục thử chất lượng tiếp theo
      }
    }

    if (!bestFormat) {
      return res.status(404).json({ error: 'Không tìm thấy định dạng video phù hợp. SESSDATA có thể không hợp lệ, hết hạn, hoặc video yêu cầu quyền truy cập cao hơn cho các định dạng có sẵn.' });
    }

    res.json({
      title: videoTitle,
      thumbnail: videoThumbnail,
      format: bestFormat
    });

  } catch (err) {
    console.error("❌ Lỗi xử lý yêu cầu tổng thể:", err.message);
    if (err.stack) {
      console.error("Chi tiết:", err.stack);
    }

    if (err.status === 403) {
      return res.status(403).json({ error: 'SESSDATA hết hạn, không hợp lệ hoặc không có quyền truy cập video này.' });
    }
    if (err.status === 400) { // Lỗi từ phía client do hàm callBilibiliAPI có thể ném
        return res.status(400).json({ error: err.message});
    }
    // Các lỗi khác từ API Bilibili đã được log status
    if (err.message && err.message.includes('API Bilibili')) {
        return res.status(err.status || 502).json({error: `Lỗi từ Bilibili: ${err.message}`});
    }

    return res.status(500).json({
      error: 'Lỗi máy chủ nội bộ',
      detail: err.message
      // Không nên gửi stack trace ra client trong production
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
});
