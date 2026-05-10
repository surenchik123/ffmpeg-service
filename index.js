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

app.use(express.json());

// ─── Concurrency queue ────────────────────────────────────────────────────────
// Railway free tier has ~512MB RAM. One FFmpeg encode can peak at 200-400MB.
// Running multiple in parallel causes SIGKILL. We serialize all jobs.
const MAX_CONCURRENT = 1;
let activeJobs = 0;
const jobQueue = [];

function enqueueJob(fn) {
  return new Promise((resolve, reject) => {
    jobQueue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length > 0) {
    const { fn, resolve, reject } = jobQueue.shift();
    activeJobs++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeJobs--;
        drainQueue();
      });
  }
}
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ffmpeg-service',
    version: '11.0.0',
    queue: { active: activeJobs, waiting: jobQueue.length }
  });
});

function runFFmpeg(inputPath, outputPath, res, ts) {
  const inputSize = fs.statSync(inputPath).size;
  console.log(`[${ts}] input: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

  if (inputSize === 0) {
    cleanup(inputPath);
    return Promise.resolve(res.status(400).json({ error: 'empty input file' }));
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

  console.log(`[${ts}] starting ffmpeg... (active jobs: ${activeJobs})`);

  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 5 * 60 * 1000
    }, (err, _stdout, stderr) => {
      cleanup(inputPath);

      if (err) {
        console.error(`[${ts}] ffmpeg error (code=${err.code}, signal=${err.signal}):`, stderr.slice(-500));
        cleanup(outputPath);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'ffmpeg failed',
            code: err.code,
            signal: err.signal,
            detail: stderr.slice(-500)
          });
        }
        return resolve();
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        cleanup(outputPath);
        if (!res.headersSent) res.status(500).json({ error: 'output empty or missing' });
        return resolve();
      }

      const outputSize = fs.statSync(outputPath).size;
      console.log(`[${ts}] output: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);

      fs.readFile(outputPath, (readErr, data) => {
        cleanup(outputPath);
        if (readErr) {
          if (!res.headersSent) res.status(500).json({ error: 'read failed' });
          return resolve();
        }
        console.log(`[${ts}] sending ${(data.length / 1024 / 1024).toFixed(1)} MB`);
        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="output.mp4"',
          'Content-Length': data.length,
          'Connection': 'close'
        });
        res.end(data);
        resolve();
      });
    });
  });
}

app.post('/process', (req, res) => {
  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] /process — writing input... (queue: ${jobQueue.length} waiting)`);

  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error(`[${ts}] write error:`, err.message);
    cleanup(inputPath);
    if (!res.headersSent) res.status(500).json({ error: 'write failed', detail: err.message });
  });

  writeStream.on('finish', () => {
    enqueueJob(() => runFFmpeg(inputPath, outputPath, res, ts));
  });
});

app.post('/process-url', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body' });
  }

  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] /process-url — downloading: ${url} (queue: ${jobQueue.length} waiting)`);

  const doDownload = (targetUrl, redirectCount = 0) => {
    if (redirectCount > 5) {
      cleanup(inputPath);
      if (!res.headersSent) res.status(500).json({ error: 'Too many redirects' });
      return;
    }

    const protocol = targetUrl.startsWith('https') ? https : http;

    protocol.get(targetUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`[${ts}] redirect → ${response.headers.location}`);
        return doDownload(response.headers.location, redirectCount + 1);
      }

      if (response.statusCode !== 200) {
        cleanup(inputPath);
        if (!res.headersSent) res.status(502).json({ error: `Upstream returned ${response.statusCode}` });
        return;
      }

      const writeStream = fs.createWriteStream(inputPath);
      response.pipe(writeStream);

      writeStream.on('error', (err) => {
        console.error(`[${ts}] download write error:`, err.message);
        cleanup(inputPath);
        if (!res.headersSent) res.status(500).json({ error: 'download write failed', detail: err.message });
      });

      writeStream.on('finish', () => {
        console.log(`[${ts}] download complete, queuing ffmpeg...`);
        enqueueJob(() => runFFmpeg(inputPath, outputPath, res, ts));
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
  console.log(`ffmpeg-service v11 listening on port ${PORT}`);
  console.log(`Max concurrent FFmpeg jobs: ${MAX_CONCURRENT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
