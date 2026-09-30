import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const resumeDir = path.join(dataDir, 'resumes');
const dataFile = path.join(dataDir, 'store.json');
fs.mkdirSync(resumeDir, { recursive: true });

const seed = {
  profile: { name: 'Jordan Davis', title: 'Product Designer', email: '', phone: '', location: 'New York, NY', skills: ['Product strategy', 'UX research', 'Design systems'], summary: '', links: [] },
  resumes: [],
  jobs: [
    { id: 1, company: 'Airbnb', initial: 'A', title: 'Senior Product Designer', place: 'Remote · United States', salary: '$145k – $182k', match: '96%', status: 'review' },
    { id: 2, company: 'Notion', initial: 'N', title: 'Product Designer, Growth', place: 'New York, NY · Hybrid', salary: '$130k – $165k', match: '92%', status: 'review' },
    { id: 3, company: 'Linear', initial: 'L', title: 'Product Designer, Core', place: 'Remote · North America', salary: '$140k – $175k', match: '89%', status: 'review' }
  ],
  applications: [], runs: [],
  integrations: [
    { id: 'greenhouse', name: 'Greenhouse', status: 'available' },
    { id: 'lever', name: 'Lever', status: 'available' },
    { id: 'linkedin', name: 'LinkedIn', status: 'browser_handoff', url: 'https://www.linkedin.com/jobs/application-settings/' },
    { id: 'indeed', name: 'Indeed', status: 'browser_handoff', url: 'https://profile.indeed.com/' }
  ]
};

function read() {
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(seed, null, 2));
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  data.resumes ||= [];
  data.profile ||= structuredClone(seed.profile);
  data.profile.links ||= [];
  data.profile.skills ||= [];
  return data;
}
const save = data => fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const parse = (req, limit = 12 * 1024 * 1024) => new Promise((resolve, reject) => {
  let text = '';
  req.on('data', chunk => { text += chunk; if (text.length > limit) reject(new Error('Request too large')); });
  req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});

function safeName(name = 'resume') { return path.basename(name).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100); }
async function extractText(buffer, filename, mime = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return (await pdfParse(buffer)).text.trim();
  if (ext === '.docx' || mime.includes('wordprocessingml')) return (await mammoth.extractRawText({ buffer })).value.trim();
  if (['.txt', '.rtf', '.md'].includes(ext) || mime.startsWith('text/')) return buffer.toString('utf8').trim();
  throw new Error('Supported resume formats: PDF, DOCX, TXT, RTF, and MD');
}
function profileSuggestions(text) {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)?.[0] || '';
  const links = [...new Set(text.match(/https?:\/\/[^\s)]+/g) || [])].slice(0, 8);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return { name: lines[0]?.length < 80 ? lines[0] : '', email, phone, links, summary: lines.slice(1, 5).join(' ').slice(0, 500) };
}
function templateResume(profile, job) {
  return `${profile.name}\n${profile.title}\n${profile.location} · ${profile.email}${profile.phone ? ` · ${profile.phone}` : ''}\n\nTARGET ROLE\n${job.title} at ${job.company}\n\nSUMMARY\n${profile.summary || `${profile.title} with experience aligned to ${job.title}.`}\n\nCORE SKILLS\n${(profile.skills || []).join(' • ')}\n\nAPPLICATION NOTES\nTailored from confirmed Northstar profile data. Review before submitting.`;
}
async function generateResume(profile, job, sourceText = '') {
  const prompt = `Create a concise, truthful ATS-friendly resume draft. Never invent employers, dates, metrics, education, credentials, or skills. Use only the supplied candidate data and source resume. Return plain text with CONTACT, SUMMARY, CORE SKILLS, EXPERIENCE, EDUCATION, and APPLICATION NOTES. Candidate: ${JSON.stringify(profile)}. Source resume: ${sourceText.slice(0, 16000)}. Job: ${JSON.stringify(job)}.`;
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5-mini', input: prompt, store: false }) });
    if (response.ok) { const result = await response.json(); return { text: result.output_text || templateResume(profile, job), provider: 'openai' }; }
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (response.ok) { const result = await response.json(); return { text: result.candidates?.[0]?.content?.parts?.[0]?.text || templateResume(profile, job), provider: 'gemini' }; }
  }
  return { text: templateResume(profile, job), provider: 'template' };
}
async function discover(data) {
  const query = encodeURIComponent(data.profile.title || 'operations');
  const feedUrl = process.env.JOB_FEED_URL || `https://remotive.com/api/remote-jobs?search=${query}&limit=20`;
  const response = await fetch(feedUrl, { headers: { 'user-agent': 'Northstar JobSeeker/0.2' } });
  if (!response.ok) throw new Error(`Job feed returned ${response.status}`);
  const incoming = await response.json();
  for (const item of (Array.isArray(incoming) ? incoming : incoming.jobs) || []) {
    const company = item.company || item.company_name;
    if (!item.title || !company || data.jobs.some(job => job.title === item.title && job.company === company)) continue;
    data.jobs.unshift({ id: crypto.randomUUID(), company, initial: company[0].toUpperCase(), title: item.title, place: item.place || item.location || item.candidate_required_location || 'Remote', salary: item.salary || 'Salary not listed', match: item.match || 'New', source: item.source || (process.env.JOB_FEED_URL ? 'Configured feed' : 'Remotive'), status: 'review', url: item.url || '' });
  }
  return data.jobs.filter(job => job.status === 'review').length;
}

async function api(req, res, url) {
  const data = read();
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, resumes: data.resumes.length });
    if (url.pathname === '/api/state') return send(res, 200, data);
    if (url.pathname === '/api/profile' && req.method === 'GET') return send(res, 200, data.profile);
    if (url.pathname === '/api/profile' && req.method === 'PUT') { data.profile = { ...data.profile, ...await parse(req) }; save(data); return send(res, 200, data.profile); }

    if (url.pathname === '/api/resumes' && req.method === 'GET') return send(res, 200, data.resumes.map(({ extractedText, ...resume }) => resume));
    if (url.pathname === '/api/resumes' && req.method === 'POST') {
      const input = await parse(req);
      const buffer = Buffer.from(input.data || '', 'base64');
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) return send(res, 400, { error: 'Resume must be between 1 byte and 8 MB' });
      const filename = safeName(input.filename);
      const text = await extractText(buffer, filename, input.mime || '');
      const id = crypto.randomUUID();
      const storedName = `${id}-${filename}`;
      fs.writeFileSync(path.join(resumeDir, storedName), buffer);
      const resume = { id, filename, storedName, mime: input.mime || 'application/octet-stream', size: buffer.length, status: 'parsed', createdAt: new Date().toISOString(), extractedText: text, suggestions: profileSuggestions(text) };
      data.resumes.unshift(resume); save(data);
      return send(res, 201, { ...resume, extractedText: text.slice(0, 4000) });
    }
    if (parts[1] === 'resumes' && parts[3] === 'apply-suggestions' && req.method === 'POST') {
      const resume = data.resumes.find(item => item.id === parts[2]);
      if (!resume) return send(res, 404, { error: 'Resume not found' });
      data.profile = { ...data.profile, ...Object.fromEntries(Object.entries(resume.suggestions).filter(([, value]) => value && (!Array.isArray(value) || value.length))) };
      data.profile.sourceResumeId = resume.id; save(data); return send(res, 200, data.profile);
    }
    if (parts[1] === 'resumes' && parts[3] === 'download' && req.method === 'GET') {
      const resume = data.resumes.find(item => item.id === parts[2]);
      if (!resume) return send(res, 404, { error: 'Resume not found' });
      const resumePath = path.join(resumeDir, resume.storedName);
      if (!fs.existsSync(resumePath)) return send(res, 404, { error: 'Resume file missing' });
      res.writeHead(200, { 'content-type': resume.mime, 'content-disposition': `attachment; filename="${resume.filename}"` }); return fs.createReadStream(resumePath).pipe(res);
    }

    if (url.pathname === '/api/jobs') return send(res, 200, data.jobs);
    if (parts[1] === 'jobs' && parts[3] === 'approve' && req.method === 'POST') {
      const job = data.jobs.find(item => String(item.id) === parts[2]); if (!job) return send(res, 404, { error: 'Job not found' });
      let application = data.applications.find(item => item.id === job.applicationId);
      if (!application) {
        application = { id: crypto.randomUUID(), jobId: job.id, company: job.company, title: job.title, status: 'resume_draft', createdAt: new Date().toISOString() };
        data.applications.push(application);
      }
      const source = data.resumes.find(item => item.id === data.profile.sourceResumeId)?.extractedText || '';
      const result = await generateResume(data.profile, job, source);
      application.status = 'resume_ready';
      application.resume = { version: `${application.company} — tailored resume`, generatedAt: new Date().toISOString(), ...result };
      job.status = 'approved'; job.applicationId = application.id; save(data); return send(res, 200, { job, application });
    }
    if (parts[1] === 'jobs' && parts[3] === 'dismiss' && req.method === 'POST') { const job = data.jobs.find(item => String(item.id) === parts[2]); if (!job) return send(res, 404, { error: 'Job not found' }); job.status = 'dismissed'; save(data); return send(res, 200, job); }
    if (url.pathname === '/api/applications') return send(res, 200, data.applications);
    if (parts[1] === 'applications' && parts[3] === 'tailor' && req.method === 'POST') {
      const application = data.applications.find(item => item.id === parts[2]); if (!application) return send(res, 404, { error: 'Application not found' });
      const job = data.jobs.find(item => item.id === application.jobId) || application;
      const source = data.resumes.find(item => item.id === data.profile.sourceResumeId)?.extractedText || '';
      const result = await generateResume(data.profile, job, source); application.status = 'resume_ready'; application.resume = { version: `${application.company} — tailored resume`, generatedAt: new Date().toISOString(), ...result }; save(data); return send(res, 200, application);
    }
    if (parts[1] === 'applications' && parts[3] === 'download' && req.method === 'GET') {
      const application = data.applications.find(item => item.id === parts[2]); if (!application?.resume?.text) return send(res, 404, { error: 'Tailored resume not ready' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${safeName(application.company)}-resume.txt"` }); return res.end(application.resume.text);
    }
    if (url.pathname === '/api/integrations' && req.method === 'GET') return send(res, 200, data.integrations);
    if (parts[1] === 'integrations' && parts[3] === 'connect' && req.method === 'POST') { const integration = data.integrations.find(item => item.id === parts[2]); if (!integration) return send(res, 404, { error: 'Integration not found' }); integration.connectedAt = new Date().toISOString(); integration.status = integration.url ? 'browser_handoff' : 'needs_credentials'; save(data); return send(res, 200, integration); }
    if (url.pathname === '/api/runs' && req.method === 'GET') return send(res, 200, data.runs);
    if (url.pathname === '/api/runs' && req.method === 'POST') { const found = await discover(data); const run = { id: crypto.randomUUID(), status: 'completed', found, startedAt: new Date().toISOString() }; data.runs.unshift(run); save(data); return send(res, 201, run); }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error); return send(res, 400, { error: error.message || 'Request failed' }); }
}

async function scheduledRun() {
  const data = read(); const now = new Date(); const hour = now.getHours(); if (hour !== 8 && hour !== 18) return;
  const key = `${now.toISOString().slice(0, 10)}-${hour}`; if (data.runs.some(run => run.scheduleKey === key)) return;
  const found = await discover(data); data.runs.unshift({ id: crypto.randomUUID(), status: 'completed', trigger: 'schedule', scheduleKey: key, found, startedAt: now.toISOString() }); save(data);
}
setInterval(scheduledRun, 60000); scheduledRun();

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`Northstar running on http://localhost:${process.env.PORT || 3000}`));
