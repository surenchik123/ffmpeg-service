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
    version: '12.0.0',
    queue: { active: activeJobs, waiting: jobQueue.length }
  });
});

function runFFmpeg(inputPath, outputPath, res, ts) {
  // Защита: файл должен существовать и не быть пустым
  let inputSize;
  try {
    inputSize = fs.statSync(inputPath).size;
  } catch (e) {
    console.error(`[${ts}] input file missing: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'input file missing', detail: e.message });
    return Promise.resolve();
  }

  console.log(`[${ts}] input: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

  if (inputSize === 0) {
    cleanup(inputPath);
    if (!res.headersSent) res.status(400).json({ error: 'empty input file' });
    return Promise.resolve();
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

  console.log(`[${ts}] starting ffmpeg... (active: ${activeJobs}, waiting: ${jobQueue.length})`);

  return new Promise((resolve) => {
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

      let outputSize;
      try {
        outputSize = fs.statSync(outputPath).size;
      } catch (e) {
        console.error(`[${ts}] output file missing after ffmpeg: ${e.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'output missing after ffmpeg' });
        return resolve();
      }

      if (outputSize === 0) {
        cleanup(outputPath);
        if (!res.headersSent) res.status(500).json({ error: 'output is empty' });
        return resolve();
      }

      console.log(`[${ts}] output: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);

      fs.readFile(outputPath, (readErr, data) => {
        cleanup(outputPath);
        if (readErr) {
          console.error(`[${ts}] read error: ${readErr.message}`);
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

// ─── POST /process — raw binary body ─────────────────────────────────────────
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

// ─── POST /process-url — Railway downloads the file itself ───────────────────
app.post('/process-url', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body' });
  }

  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] /process-url — downloading: ${url.slice(0, 80)}... (queue: ${jobQueue.length} waiting)`);

  const doDownload = (targetUrl, redirectCount = 0) => {
    if (redirectCount > 10) {
      cleanup(inputPath);
      if (!res.headersSent) res.status(500).json({ error: 'Too many redirects' });
      return;
    }

    let protocol;
    try {
      protocol = targetUrl.startsWith('https') ? https : http;
    } catch (e) {
      cleanup(inputPath);
      if (!res.headersSent) res.status(400).json({ error: 'Invalid URL', detail: e.message });
      return;
    }

    const request = protocol.get(targetUrl, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`[${ts}] redirect (${response.statusCode}) → ${response.headers.location.slice(0, 80)}`);
        response.resume(); // drain the response before following redirect
        return doDownload(response.headers.location, redirectCount + 1);
      }

      if (response.statusCode !== 200) {
        response.resume();
        cleanup(inputPath);
        if (!res.headersSent) res.status(502).json({ error: `Upstream returned ${response.statusCode}` });
        return;
      }

      const writeStream = fs.createWriteStream(inputPath);

      response.on('error', (err) => {
        console.error(`[${ts}] response stream error:`, err.message);
        cleanup(inputPath);
        if (!res.headersSent) res.status(500).json({ error: 'response stream failed', detail: err.message });
      });

      writeStream.on('error', (err) => {
        console.error(`[${ts}] write stream error:`, err.message);
        response.destroy();
        cleanup(inputPath);
        if (!res.headersSent) res.status(500).json({ error: 'download write failed', detail: err.message });
      });

      writeStream.on('finish', () => {
        console.log(`[${ts}] download complete, queuing ffmpeg...`);
        enqueueJob(() => runFFmpeg(inputPath, outputPath, res, ts));
      });

      response.pipe(writeStream);
    });

    request.on('error', (err) => {
      console.error(`[${ts}] request error:`, err.message);
      cleanup(inputPath);
      if (!res.headersSent) res.status(500).json({ error: 'download failed', detail: err.message });
    });

    request.setTimeout(60000, () => {
      console.error(`[${ts}] download timeout`);
      request.destroy();
      cleanup(inputPath);
      if (!res.headersSent) res.status(504).json({ error: 'download timeout' });
    });
  };

  doDownload(url);
});

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {
      console.warn(`cleanup failed for ${p}: ${e.message}`);
    }
  }
}

// Глобальный обработчик — предотвращает краш процесса при любой необработанной ошибке
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

app.listen(PORT, () => {
  console.log(`ffmpeg-service v12 listening on port ${PORT}`);
  console.log(`Max concurrent FFmpeg jobs: ${MAX_CONCURRENT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
