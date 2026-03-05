require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const projects = require('./projects.config');

const app = express();
app.use(cors());
app.use(express.json());

// Serve built frontend in production
const frontendPath = path.join(__dirname, 'public');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '';
const PORT = process.env.PORT || 3001;

function getGithubHeaders(tokenEnv) {
  const token = process.env[tokenEnv];
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json'
  };
}

// In-memory cache
let cache = {};
let lastScan = null;

async function fetchGithubData(owner, repo, tokenEnv) {
  const headers = getGithubHeaders(tokenEnv);
  try {
    const [repoRes, commitsRes, pullsRes] = await Promise.all([
      axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=5`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=5`, { headers })
    ]);

    const commits = commitsRes.data.map(c => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      date: c.commit.author.date,
      author: c.commit.author.name
    }));

    const pulls = pullsRes.data.map(p => ({
      title: p.title,
      state: p.state,
      number: p.number,
      updatedAt: p.updated_at
    }));

    return {
      stars: repoRes.data.stargazers_count,
      openIssues: repoRes.data.open_issues_count,
      defaultBranch: repoRes.data.default_branch,
      pushedAt: repoRes.data.pushed_at,
      updatedAt: repoRes.data.updated_at,
      description: repoRes.data.description,
      commits,
      pulls,
      githubUrl: repoRes.data.html_url
    };
  } catch (err) {
    return { error: err.response?.status === 404 ? 'Repo not found' : err.message };
  }
}

function scanLocalFolder(folderName) {
  if (!PROJECTS_ROOT) return { exists: false, files: [] };
  const fullPath = path.join(PROJECTS_ROOT, folderName);
  if (!fs.existsSync(fullPath)) return { exists: false, files: [] };

  const allFiles = fs.readdirSync(fullPath, { withFileTypes: true });
  const summary = {
    exists: true,
    path: fullPath,
    fileCount: allFiles.length,
    hasPackageJson: fs.existsSync(path.join(fullPath, 'package.json')),
    hasRequirements: fs.existsSync(path.join(fullPath, 'requirements.txt')),
    lastModified: fs.statSync(fullPath).mtime.toISOString(),
    topFiles: allFiles.slice(0, 10).map(f => f.name)
  };
  return summary;
}

// Detect any NEW folders in PROJECTS_ROOT not in config
function detectNewProjects() {
  if (!PROJECTS_ROOT || !fs.existsSync(PROJECTS_ROOT)) return [];
  const knownFolders = projects.map(p => p.localFolder.toLowerCase());
  const allFolders = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  return allFolders.filter(f => !knownFolders.includes(f.toLowerCase()));
}

async function buildProjectData() {
  const results = await Promise.all(projects.map(async (proj) => {
    const [github, local] = await Promise.all([
      fetchGithubData(proj.github.owner, proj.github.repo, proj.github.tokenEnv),
      Promise.resolve(scanLocalFolder(proj.localFolder))
    ]);

    // Infer status from GitHub activity
    let status = 'planning';
    if (github.commits && github.commits.length > 0) {
      const lastCommitDays = (Date.now() - new Date(github.commits[0].date)) / (1000 * 60 * 60 * 24);
      if (lastCommitDays < 3) status = 'in-progress';
      else if (lastCommitDays < 14) status = 'review';
      else status = 'planning';
    }
    if (github.error) status = 'planning';

    const changelog = github.commits
      ? github.commits.map(c => ({ date: c.date.split('T')[0], note: `[${c.sha}] ${c.message} — ${c.author}` }))
      : [];

    return {
      id: proj.id,
      name: proj.name,
      description: github.description || proj.name,
      status,
      tags: proj.tags,
      color: proj.color,
      lastUpdated: github.pushedAt ? github.pushedAt.split('T')[0] : null,
      changelog,
      github,
      local,
      githubUrl: github.githubUrl || null
    };
  }));

  cache = { projects: results, scannedAt: new Date().toISOString() };
  lastScan = new Date();
  return cache;
}

// Routes
app.get('/api/projects', async (req, res) => {
  try {
    if (!lastScan || (Date.now() - lastScan) > 5 * 60 * 1000) {
      await buildProjectData();
    }
    const newFolders = detectNewProjects();
    res.json({ ...cache, newFolders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    await buildProjectData();
    const newFolders = detectNewProjects();
    res.json({ ...cache, newFolders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gemini AI proxy — keeps API key server-side
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    // Build Gemini contents from messages array
    const contents = [];
    for (const msg of messages) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content || msg.text }]
      });
    }

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { maxOutputTokens: 1000 }
      }
    );

    const text = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ text });
  } catch (err) {
    console.error('Gemini error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastScan, projectCount: projects.length });
});

// SPA fallback — serve index.html for non-API routes
if (fs.existsSync(frontendPath)) {
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Kanban backend running on http://localhost:${PORT}`);
  buildProjectData(); // initial load
});
