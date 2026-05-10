const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service', version: '8.0.0' });
});

/**
 * POST /process
 * Body: raw binary video
 * Returns: MP4 1080x1920 (9:16, fills full frame, sides cropped, top banners blurred)
 *
 * Filter pipeline:
 * 1. Blur top 12% of original (covers corner banners on Twitch streams)
 * 2. Scale by height to 1920px (fills vertically, width becomes ~3413px for 16:9)
 * 3. Crop center 1080px wide → full 9:16 frame, no black bars
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

    // Filter:
    // 1. split → blur top 12% → overlay back
    // 2. scale to height=1920, keep aspect (width will be ~3413 for 16:9 source)
    // 3. crop 1080 wide from center → perfect 1080x1920 with no black bars
    const vf = [
      `[0:v]split=2[base][blur_src]`,
      `[blur_src]crop=iw:ih*0.12:0:0,boxblur=30:6[blurred_top]`,
      `[base][blurred_top]overlay=0:0[with_blur]`,
      `[with_blur]scale=-2:1920[scaled]`,
      `[scaled]crop=1080:1920[out]`
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

    console.log(`[${ts}] starting ffmpeg (fill 9:16, blur banners)...`);

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
  console.log(`ffmpeg-service v8 listening on port ${PORT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
