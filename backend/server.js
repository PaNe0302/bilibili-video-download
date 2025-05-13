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

// API chính để lấy thông tin video và định dạng tải xuống
app.get('/api/video', async (req, res) => {
  const { url, sessdata } = req.query;

  if (!url || !url.includes('bilibili.com')) {
    return res.status(400).json({ error: 'URL không hợp lệ. Phải là video từ bilibili.com' });
  }

  if (!sessdata) {
    // Không trả lỗi 400 ngay, frontend sẽ xử lý việc thiếu sessdata
    // return res.status(400).json({ error: 'SESSDATA là bắt buộc.' });
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
    // Cần SESSDATA để gọi API view trong nhiều trường hợp, nhưng thử gọi trước xem có cần không
    let infoData;
    try {
        infoData = await callBilibiliAPI(viewApiUrl, sessdata || ''); // Thử gọi với sessdata hoặc chuỗi rỗng
    } catch (viewErr) {
         // Nếu lỗi khi gọi API view, kiểm tra nếu do thiếu SESSDATA
        if (viewErr.status === 403) {
             return res.status(403).json({ error: 'Không thể lấy thông tin video. Có thể SESSDATA hết hạn, không hợp lệ hoặc video bị giới hạn quyền truy cập.'});
        } else {
             throw viewErr; // Ném lỗi khác nếu không phải 403
        }
    }

    if (infoData.code !== 0 || !infoData.data || !infoData.data.cid) {
      console.error('Lỗi lấy cid:', infoData);
      // Lỗi từ API Bilibili không phải 403 nhưng không lấy được data/cid
      return res.status(infoData.code === -400 ? 400 : 500).json({
          error: `Không thể lấy thông tin video (cid). Mã lỗi Bilibili: ${infoData.code}. Message: ${infoData.message || 'Không có message'}`
      });
    }
    const cid = infoData.data.cid;
    const videoTitle = infoData.data.title;
    const videoThumbnail = infoData.data.pic;

    // Các độ phân giải ưu tiên (chỉ dùng để tìm qn và label)
    const QUALITIES = [
      { qn: 120, label: '4K HDR' },
      { qn: 116, label: '1080P 60fps (HEVC)'},
      { qn: 112, label: '1080P+ (HDR)' },
      { qn: 80, label: '1080P' },
      { qn: 74, label: '720P 60fps (HEVC)'},
      { qn: 64, label: '720P' },
      { qn: 32, label: '480P' },
      { qn: 16, label: '360P' }
    ];

    let selectedFormat = null; // Lưu thông tin định dạng tốt nhất tìm được

    // Tìm chất lượng tốt nhất có thể tải
    for (const quality of QUALITIES) {
      const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`; // fnval=16 cho DASH
      try {
        // Chỉ cần kiểm tra xem API playurl có trả về luồng video không
        const playData = await callBilibiliAPI(playUrlApi, sessdata || ''); // Gọi với sessdata (nếu có) hoặc rỗng

        if (playData.code === 0 && playData.data?.dash?.video?.length > 0) {
           // Nếu thành công, lưu lại thông tin chất lượng này và dừng tìm kiếm
           selectedFormat = { ...quality, // Lưu qn và label
                              // Thêm thông tin ước tính size và link (vẫn giữ link tạm thời cho frontend)
                              size: playData.data.dash.video[0].bandwidth ? (playData.data.dash.video[0].bandwidth * (infoData.data.duration || 300) / 8 / 1024 / 1024).toFixed(2) + ' MB (ước tính)' : 'Không rõ',
                              // Link này sẽ KHÔNG được dùng trực tiếp bởi frontend để tải
                              link: playData.data.dash.video[0].baseUrl || (playData.data.dash.video[0].backupUrl && playData.data.dash.video[0].backupUrl[0])
                            };
            console.log(`Tìm thấy chất lượng ${quality.label} (qn: ${quality.qn}) cho bvid ${bvid}`);
            break; // Tìm thấy chất lượng tốt nhất, thoát vòng lặp
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

    if (!selectedFormat) {
      // Nếu không tìm thấy định dạng nào tải được
      return res.status(404).json({ error: 'Không tìm thấy định dạng video phù hợp. SESSDATA có thể không hợp lệ, hết hạn, hoặc video yêu cầu quyền truy cập cao hơn cho các định dạng có sẵn.' });
    }

    // Trả về thông tin video và định dạng tốt nhất đã tìm được
    res.json({
      title: videoTitle,
      thumbnail: videoThumbnail,
      bvid: bvid,
      cid: cid,
      format: selectedFormat // Bao gồm qn, label, size, link (link này chỉ mang tính tham khảo, frontend dùng bvid, cid, qn để gọi /api/download)
    });

  } catch (err) {
    console.error("❌ Lỗi xử lý yêu cầu /api/video tổng thể:", err.message);
    if (err.stack) {
      console.error("Chi tiết:", err.stack);
    }

    if (err.status === 403) {
      // Lỗi 403 từ API view hoặc playurl
      return res.status(403).json({ error: 'SESSDATA hết hạn, không hợp lệ hoặc không có quyền truy cập video này.' });
    }
     if (err.status === 400 || (err.message && err.message.includes('bvid hợp lệ'))) {
         return res.status(400).json({error: err.message});
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

// API để tải video (backend proxy)
app.get('/api/download', async (req, res) => {
    const { bvid, cid, qn, sessdata, title } = req.query;

    if (!bvid || !cid || !qn) {
        return res.status(400).json({ error: 'Thiếu thông tin video (bvid, cid, qn) để tải xuống.' });
    }

    if (!sessdata) {
         // Endpoint download KHÔNG TỰ YÊU CẦU sessdata. Frontend đảm bảo gửi sessdata lên.
         return res.status(400).json({ error: 'SESSDATA là bắt buộc để tải xuống.' });
    }

    try {
        // Gọi API playurl của Bilibili để lấy URL stream trực tiếp
        const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=16`;
        const playData = await callBilibiliAPI(playUrlApi, sessdata);

        if (playData.code !== 0 || !playData.data?.dash?.video?.length > 0) {
             console.error('Lỗi lấy stream URL từ Bilibili API:', playData);
             return res.status(500).json({
                 error: `Không thể lấy URL stream từ Bilibili. Mã lỗi Bilibili: ${playData.code}. Message: ${playData.message || 'Không có message'}`
             });
        }

        const videoStreamUrl = playData.data.dash.video[0].baseUrl || (playData.data.dash.video[0].backupUrl && playData.data.dash.video[0].backupUrl[0]);

        if (!videoStreamUrl) {
             console.error('Không tìm thấy baseUrl hoặc backupUrl trong phản hồi API playurl', playData);
             return res.status(500).json({ error: 'Không tìm thấy URL stream video.' });
        }

        console.log(`Đang tải stream từ: ${videoStreamUrl}`);

        // Thiết lập header cho phản hồi tải xuống
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || bvid)}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4'); // Hoặc loại MIME phù hợp
        res.setHeader('Transfer-Encoding', 'chunked');

        // Tải stream từ Bilibili và pipe về response
        const streamResponse = await axios({
            method: 'get',
            url: videoStreamUrl,
            responseType: 'stream',
            headers: {
                 // RẤT QUAN TRỌNG: Gửi SESSDATA (và có thể Referer) khi tải stream trực tiếp
                 'Cookie': `SESSDATA=${sessdata}`,
                 'Referer': 'https://www.bilibili.com/', // Thêm Referer
                 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36'
            }
        });

        // Pipe stream từ Bilibili về client
        streamResponse.data.pipe(res);

        // Xử lý lỗi trong quá trình stream
        streamResponse.data.on('error', (streamErr) => {
            console.error('Lỗi khi stream dữ liệu video:', streamErr);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Lỗi khi truyền dữ liệu video.' });
            } else {
                // Nếu headers đã gửi, chỉ có thể đóng kết nối
                res.end();
            }
        });

        // Log khi stream hoàn tất (không bắt buộc nhưng hữu ích cho debug)
        streamResponse.data.on('end', () => {
            console.log('Stream hoàn tất.');
        });

    } catch (err) {
        console.error("❌ Lỗi xử lý yêu cầu /api/download tổng thể:", err.message);
         if (err.stack) {
            console.error("Chi tiết:", err.stack);
        }

        if (!res.headersSent) {
             if (err.status === 403) {
                return res.status(403).json({ error: 'SESSDATA hết hạn, không hợp lệ hoặc không có quyền tải video này.' });
            }
             if (err.status === 400) {
                 return res.status(400).json({ error: err.message});
             }
             if (err.message && err.message.includes('API Bilibili')) {
                 return res.status(err.status || 502).json({error: `Lỗi từ Bilibili khi lấy stream URL: ${err.message}`});
             }
             return res.status(500).json({
                error: 'Lỗi máy chủ nội bộ',
                detail: err.message
             });
        } else {
            // Nếu lỗi xảy ra sau khi headers đã gửi (ví dụ trong pipe), chỉ có thể đóng kết nối
            console.error('Lỗi sau khi gửi headers:', err.message);
            res.end();
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
});
