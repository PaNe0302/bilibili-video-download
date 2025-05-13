const express = require('express');
const axios = require('axios');
// Xóa require('child_process') hoặc liên quan đến ffmpeg nếu có

const app = express();

// Middleware hỗ trợ CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // Giữ nguyên theo yêu cầu
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Hàm helper để gọi API Bilibili với SESSDATA và Referer
async function callBilibiliAPI(apiUrl, sessdata) {
  try {
    const response = await axios.get(apiUrl, {
      headers: {
        'Cookie': `SESSDATA=${sessdata}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36', // Thêm User-Agent để giả lập trình duyệt
        'Referer': 'https://www.bilibili.com/' // Thêm Referer header
      }
    });
    return response.data;
  } catch (error) {
    // Ném lỗi để hàm gọi có thể xử lý
    if (error.response) {
      // Lỗi từ phía server Bilibili (ví dụ: 403, 404, 412)
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

// API chính để lấy thông tin video và định dạng tải xuống
// Endpoint này sẽ trả về URL của video và audio riêng biệt cho các chất lượng >= 720p
app.get('/api/video', async (req, res) => {
  const { url, sessdata } = req.query;

  if (!url || !url.includes('bilibili.com')) {
    return res.status(400).json({ error: 'URL không hợp lệ. Phải là video từ bilibili.com' });
  }

  // sessdata là tùy chọn ở đây, nhưng cần cho video giới hạn hoặc chất lượng cao
  // if (!sessdata) {
  //   return res.status(400).json({ error: 'SESSDATA là bắt buộc.' });
  // }

  try {
    // Trích xuất bvid từ URL
    const bvidMatch = url.match(/BV[A-Za-z0-9]{10}/);
    if (!bvidMatch) {
      return res.status(400).json({ error: 'Không tìm thấy bvid hợp lệ trong URL' });
    }
    const bvid = bvidMatch[0];

    // Gọi API Bilibili để lấy cid và thông tin chung
    const viewApiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
     let infoData;
    try {
        infoData = await callBilibiliAPI(viewApiUrl, sessdata || ''); // Thử gọi với sessdata hoặc chuỗi rỗng
    } catch (viewErr) {
         if (viewErr.status === 403) {
             return res.status(403).json({ error: 'Không thể lấy thông tin video. Có thể SESSDATA hết hạn, không hợp lệ hoặc video bị giới hạn quyền truy cập.'});
        } else if (viewErr.status === 400 && viewErr.data?.code === -400) {
            return res.status(400).json({error: `Lỗi từ Bilibili khi lấy thông tin video: ${viewErr.data.message || viewErr.message}`});
        } else {
             throw viewErr;
        }
    }


    if (infoData.code !== 0 || !infoData.data || !infoData.data.cid) {
      console.error('Lỗi lấy cid từ Bilibili API:', infoData);
      return res.status(infoData.code === -400 ? 400 : 500).json({
          error: `Không thể lấy thông tin video (cid). Mã lỗi Bilibili: ${infoData.code}. Message: ${infoData.message || 'Không có message'}`
      });
    }
    const cid = infoData.data.cid;
    const videoTitle = infoData.data.title;
    const videoThumbnail = infoData.data.pic;

    // Các độ phân giải ưu tiên (chỉ dùng để tìm qn và label)
    // Chỉ lấy các chất lượng từ 720p trở lên theo yêu cầu
    const QUALITIES = [
      { qn: 120, label: '4K HDR' },
      { qn: 116, label: '1080P 60fps (HEVC)'},
      { qn: 112, label: '1080P+ (HDR)' },
      { qn: 80, label: '1080P' },
      { qn: 74, label: '720P 60fps (HEVC)'},
      { qn: 64, label: '720P' }
      // Các chất lượng thấp hơn sẽ không được cung cấp URL riêng
    ];

    const availableQualities = [];

    // Tìm các chất lượng có sẵn luồng video và audio
    for (const quality of QUALITIES) {
      // fnval=16 yêu cầu định dạng DASH
      const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`;
      try {
        const playData = await callBilibiliAPI(playUrlApi, sessdata || '');

        // Kiểm tra nếu có cả luồng video và audio trong định dạng DASH
        if (playData.code === 0 && playData.data?.dash?.video?.length > 0 && playData.data?.dash?.audio?.length > 0) {
           const videoStreamUrl = playData.data.dash.video[0].baseUrl || (playData.data.dash.video[0].backupUrl && playData.data.dash.video[0].backupUrl[0]);
           const audioStreamUrl = playData.data.dash.audio[0].baseUrl || (playData.data.dash.audio[0].backupUrl && playData.data.dash.audio[0].backupUrl[0]);

           if(videoStreamUrl && audioStreamUrl){
               availableQualities.push({
                   qn: quality.qn,
                   label: quality.label,
                   videoUrl: videoStreamUrl,
                   audioUrl: audioStreamUrl
               });
               console.log(`Tìm thấy chất lượng ${quality.label} (qn: ${quality.qn}) với URL video và audio cho bvid ${bvid}`);
           } else {
              console.warn(`Không có baseUrl hoặc backupUrl cho cả luồng video/audio DASH cho chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}.`);
           }
        } else {
           console.warn(`Không có luồng video/audio DASH cho chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}. Code: ${playData.code}, Message: ${playData.message}`);
        }
      } catch (e) {
        console.error(`Lỗi khi lấy playurl cho chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}:`, e.message, e.status ? `Status: ${e.status}` : '');
        // Tiếp tục thử chất lượng tiếp theo nếu có lỗi
      }
    }

    if (availableQualities.length === 0) {
      // Nếu không tìm thấy định dạng nào có cả video và audio >= 720p
      return res.status(404).json({ error: 'Không tìm thấy định dạng video/audio phù hợp (>= 720p). Có thể SESSDATA không hợp lệ, hết hạn, hoặc video chỉ có các định dạng cũ/thấp hơn.' });
    }

    // Trả về thông tin video và danh sách các chất lượng có URL video+audio
    res.json({
      title: videoTitle,
      thumbnail: videoThumbnail,
      bvid: bvid,
      cid: cid,
      availableQualities: availableQualities
    });

  } catch (err) {
    console.error("❌ Lỗi xử lý yêu cầu /api/video tổng thể:", err.message);
    if (err.stack) {
      console.error("Chi tiết:", err.stack);
    }

    // Xử lý các loại lỗi từ API Bilibili hoặc lỗi nội bộ
    if (err.status === 403) {
      return res.status(403).json({ error: 'SESSDATA hết hạn, không hợp lệ hoặc không có quyền truy cập video này.' });
    }
     if (err.status === 400 || (err.message && err.message.includes('bvid hợp lệ'))) {
         return res.status(400).json({error: err.message});
     }
    // Lỗi từ Bilibili API (có status khác 403, 400)
    if (err.message && err.message.includes('API Bilibili')) {
        return res.status(err.status || 502).json({error: `Lỗi từ Bilibili: ${err.message}`});
    }
    // Lỗi nội bộ khác
    return res.status(500).json({
      error: 'Lỗi máy chủ nội bộ',
      detail: err.message
    });
  }
});

// Xóa endpoint /api/download
// app.get('/api/download', ...); // Endpoint này không còn cần thiết

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
});
