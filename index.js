const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service', version: '7.0.0' });
});

/**
 * POST /process
 * Body: raw binary video
 * Returns: MP4 1080x1920 (9:16, 1.3x zoom, top banner blurred, black bars reduced)
 *
 * Filter pipeline:
 * 1. Blur top 15% of original (covers corner banners)
 * 2. Scale up by 1.3x (zoom in, crops edges)
 * 3. Crop center to original dimensions
 * 4. Scale + pad to 1080x1920 (9:16)
 */
app.post('/process', (req, res) => {
  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] writing input...`);

  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error(`[${ts}] write error:`, err.message);
    cleanup(inputPath);
    if (!res.headersSent) res.status(500).json({ error: 'write failed', detail: err.message });
  });

  writeStream.on('finish', () => {
    const inputSize = fs.statSync(inputPath).size;
    console.log(`[${ts}] input: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

    if (inputSize === 0) {
      cleanup(inputPath);
      return res.status(400).json({ error: 'empty input file' });
    }

    // Filter graph:
    // 1. Split original into two streams
    // 2. Blur top 15% of original → [blurred_top]
    // 3. Overlay blurred_top onto original → [with_blur]
    // 4. Scale up 1.3x → [zoomed]
    // 5. Crop center back to original size → [cropped]
    // 6. Scale + pad to 1080x1920 (9:16) → [out]
    const ZOOM = 1.3;
    const vf = [
      `[0:v]split=2[base][blur_src]`,
      `[blur_src]crop=iw:ih*0.15:0:0,boxblur=25:5[blurred_top]`,
      `[base][blurred_top]overlay=0:0[with_blur]`,
      `[with_blur]scale=iw*${ZOOM}:ih*${ZOOM}[zoomed]`,
      `[zoomed]crop=iw/${ZOOM}:ih/${ZOOM}[cropped]`,
      `[cropped]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black[out]`
    ].join(';');

    const args = [
      '-y',
      '-loglevel', 'warning',
      '-i', inputPath,
      '-filter_complex', vf,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[${ts}] starting ffmpeg (blur + 1.3x zoom)...`);

    execFile('ffmpeg', args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    }, (err, _stdout, stderr) => {
      cleanup(inputPath);

      if (err) {
        console.error(`[${ts}] ffmpeg error (code=${err.code}, signal=${err.signal}):`, stderr.slice(-1000));
        cleanup(outputPath);
        if (!res.headersSent) {
          return res.status(500).json({
            error: 'ffmpeg failed',
            code: err.code,
            signal: err.signal,
            detail: stderr.slice(-500)
          });
        }
        return;
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        cleanup(outputPath);
        if (!res.headersSent) return res.status(500).json({ error: 'output empty or missing' });
        return;
      }

      const outputSize = fs.statSync(outputPath).size;
      console.log(`[${ts}] output: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);

      fs.readFile(outputPath, (readErr, data) => {
        cleanup(outputPath);
        if (readErr) {
          if (!res.headersSent) return res.status(500).json({ error: 'read failed' });
          return;
        }
        console.log(`[${ts}] sending ${(data.length / 1024 / 1024).toFixed(1)} MB`);
        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="output.mp4"',
          'Content-Length': data.length,
          'Connection': 'close'
        });
        res.end(data);
      });
    });
  });
});

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`ffmpeg-service v7 listening on port ${PORT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
