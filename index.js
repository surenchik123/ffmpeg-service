const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Parse JSON body for /process-url
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service', version: '10.0.0' });
});

/**
 * Shared FFmpeg processing logic.
 * inputPath  — path to downloaded input file
 * outputPath — path to write output file
 * res        — Express response object
 * ts         — timestamp for logging
 */
function runFFmpeg(inputPath, outputPath, res, ts) {
  const inputSize = fs.statSync(inputPath).size;
  console.log(`[${ts}] input: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

  if (inputSize === 0) {
    cleanup(inputPath);
    return res.status(400).json({ error: 'empty input file' });
  }

  const vf = 'scale=-2:1920,crop=1080:1920';

  const args = [
    '-y',
    '-loglevel', 'warning',
    '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    '-threads', '1',
    outputPath
  ];

  console.log(`[${ts}] starting ffmpeg (scale+crop only)...`);

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
}

/**
 * POST /process
 * Body: raw binary video
 * Returns: MP4 1080x1920 (9:16, crop, no black bars)
 */
app.post('/process', (req, res) => {
  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] /process — writing input...`);

  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error(`[${ts}] write error:`, err.message);
    cleanup(inputPath);
    if (!res.headersSent) res.status(500).json({ error: 'write failed', detail: err.message });
  });

  writeStream.on('finish', () => {
    runFFmpeg(inputPath, outputPath, res, ts);
  });
});

/**
 * POST /process-url
 * Body: { "url": "https://..." }
 * Railway downloads the file itself — n8n doesn't hold binary in memory.
 * Returns: MP4 1080x1920 (9:16, crop, no black bars)
 */
app.post('/process-url', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body' });
  }

  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] /process-url — downloading: ${url}`);

  const protocol = url.startsWith('https') ? https : http;

  const doDownload = (targetUrl, redirectCount = 0) => {
    if (redirectCount > 5) {
      cleanup(inputPath);
      return res.status(500).json({ error: 'Too many redirects' });
    }

    protocol.get(targetUrl, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`[${ts}] redirect → ${response.headers.location}`);
        return doDownload(response.headers.location, redirectCount + 1);
      }

      if (response.statusCode !== 200) {
        cleanup(inputPath);
        return res.status(502).json({ error: `Upstream returned ${response.statusCode}` });
      }

      const writeStream = fs.createWriteStream(inputPath);
      response.pipe(writeStream);

      writeStream.on('error', (err) => {
        console.error(`[${ts}] download write error:`, err.message);
        cleanup(inputPath);
        if (!res.headersSent) res.status(500).json({ error: 'download write failed', detail: err.message });
      });

      writeStream.on('finish', () => {
        console.log(`[${ts}] download complete, running ffmpeg...`);
        runFFmpeg(inputPath, outputPath, res, ts);
      });
    }).on('error', (err) => {
      console.error(`[${ts}] download error:`, err.message);
      cleanup(inputPath);
      if (!res.headersSent) res.status(500).json({ error: 'download failed', detail: err.message });
    });
  };

  doDownload(url);
});

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`ffmpeg-service v10 listening on port ${PORT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
