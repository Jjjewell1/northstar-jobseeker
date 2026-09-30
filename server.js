import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const resumeDir = path.join(dataDir, 'resumes');
const profileDir = path.join(dataDir, 'profile');
const dataFile = path.join(dataDir, 'store.json');
fs.mkdirSync(resumeDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const seed = {
  account: null,
  sessions: [],
  profile: { name: '', title: '', email: '', phone: '', location: '', skills: [], summary: '', links: [] },
  resumes: [],
  jobs: [],
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
  data.sessions ||= [];
  data.profile ||= structuredClone(seed.profile);
  data.profile.links ||= [];
  data.profile.skills ||= [];
  data.jobs = (data.jobs || []).filter(job => job.source || ![1, 2, 3].includes(job.id));
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

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)));
async function passwordMatches(password, stored = '') {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const candidate = await passwordHash(password, salt);
  const candidateHex = candidate.split(':')[1];
  return candidateHex.length === expectedHex.length && crypto.timingSafeEqual(Buffer.from(candidateHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2)); }
function currentUser(req, data) {
  const token = cookies(req).northstar_session;
  if (!token || !data.account) return null;
  const now = Date.now();
  data.sessions = data.sessions.filter(session => new Date(session.expiresAt).getTime() > now);
  return data.sessions.some(session => session.tokenHash === hashToken(token)) ? { name: data.account.name, email: data.account.email } : null;
}
function startSession(res, data) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  data.sessions.push({ tokenHash: hashToken(token), expiresAt });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `northstar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}
function endSession(req, res, data) {
  const token = cookies(req).northstar_session;
  if (token) data.sessions = data.sessions.filter(session => session.tokenHash !== hashToken(token));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `northstar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function safeName(name = 'resume') { return path.basename(name).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100); }
function profileView(profile) { const { photoStoredName, ...safe } = profile; return { ...safe, hasPhoto: Boolean(photoStoredName), photoUrl: photoStoredName ? '/api/profile/photo' : '' }; }
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
function templateResume(profile, job, sourceText = '') {
  return `${profile.name}\n${profile.title || job.title}\n${[profile.location, profile.email, profile.phone].filter(Boolean).join(' · ')}\n\nPROFESSIONAL SUMMARY\n${profile.summary || `Candidate targeting ${job.title} opportunities at ${job.company}.`}\n\nCORE SKILLS\n${(profile.skills || []).join(' • ')}\n\nPROFESSIONAL EXPERIENCE\n${sourceText || 'Add a master resume to include verified experience.'}\n\nTARGET ROLE\n${job.title} at ${job.company}`;
}
async function generateResume(profile, job, sourceText = '') {
  const prompt = `Create a concise, truthful ATS-friendly resume draft. Never invent employers, dates, metrics, education, credentials, or skills. Use only the supplied candidate data and source resume. Return plain text with CONTACT, SUMMARY, CORE SKILLS, EXPERIENCE, EDUCATION, and APPLICATION NOTES. Candidate: ${JSON.stringify(profile)}. Source resume: ${sourceText.slice(0, 16000)}. Job: ${JSON.stringify(job)}.`;
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5-mini', input: prompt, store: false }) });
    if (response.ok) { const result = await response.json(); return { text: result.output_text || templateResume(profile, job, sourceText), provider: 'openai' }; }
  }
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (response.ok) { const result = await response.json(); return { text: result.candidates?.[0]?.content?.parts?.[0]?.text || templateResume(profile, job, sourceText), provider: 'gemini' }; }
  }
  return { text: templateResume(profile, job, sourceText), provider: 'template' };
}

function resumeSections(text = '') {
  const headings = new Set(['CONTACT', 'PROFESSIONAL SUMMARY', 'SUMMARY', 'CORE SKILLS', 'SKILLS', 'PROFESSIONAL EXPERIENCE', 'EXPERIENCE', 'EDUCATION', 'CERTIFICATIONS', 'TARGET ROLE', 'APPLICATION NOTES']);
  const sections = []; let current = { title: '', lines: [] };
  for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line) continue; if (headings.has(line.toUpperCase())) { if (current.lines.length) sections.push(current); current = { title: line.toUpperCase(), lines: [] }; } else current.lines.push(line); }
  if (current.lines.length) sections.push(current); return sections;
}
async function atsDocx(application, profile) {
  const sections = resumeSections(application.resume.text); const children = [];
  const first = sections.shift(); const headerLines = first?.title ? [] : (first?.lines || []).slice(0, 3);
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: profile.name || headerLines[0] || '', bold: true, size: 34, font: 'Arial' })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 220 }, children: [new TextRun({ text: [profile.title || application.title, profile.location, profile.email, profile.phone].filter(Boolean).join(' | '), size: 20, font: 'Arial' })] }));
  for (const section of sections) { if (section.title === 'TARGET ROLE' || section.title === 'APPLICATION NOTES') continue; children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 180, after: 80 }, children: [new TextRun({ text: section.title || 'PROFILE', bold: true, size: 23, font: 'Arial', color: '1D5F4A' })] })); for (const line of section.lines) children.push(new Paragraph({ spacing: { after: 70 }, children: [new TextRun({ text: line, size: 20, font: 'Arial' })] })); }
  const doc = new Document({ styles: { default: { document: { run: { font: 'Arial', size: 20 } } } }, sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }] });
  return Packer.toBuffer(doc);
}
function visualPdf(application, profile, photoPath = '') { return new Promise((resolve, reject) => { const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, left: 54, right: 54, bottom: 54 }, info: { Title: `${profile.name} Resume`, Author: profile.name } }); const chunks = []; doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); doc.rect(0, 0, 612, 116).fill('#173D33'); doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(24).text(profile.name || '', 54, 40, { width: photoPath ? 410 : 504 }); doc.font('Helvetica').fontSize(11).fillColor('#D8F06B').text(profile.title || application.title, 54, 74); doc.fontSize(9).fillColor('#EAF3ED').text([profile.location, profile.email, profile.phone].filter(Boolean).join('  •  '), 54, 94); if (photoPath && fs.existsSync(photoPath)) { try { doc.save().circle(548, 58, 36).clip().image(photoPath, 512, 22, { fit: [72, 72], align: 'center', valign: 'center' }).restore(); } catch {} } doc.y = 142; for (const section of resumeSections(application.resume.text)) { if (!section.title || section.title === 'TARGET ROLE' || section.title === 'APPLICATION NOTES') continue; if (doc.y > 680) doc.addPage(); doc.fillColor('#1D5F4A').font('Helvetica-Bold').fontSize(11).text(section.title, { characterSpacing: .7 }); doc.moveDown(.25); doc.fillColor('#26332E').font('Helvetica').fontSize(9.5); for (const line of section.lines) doc.text(line, { lineGap: 2 }); doc.moveDown(.7); } doc.end(); }); }

async function assistWithGemini(field, value, profile) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw Object.assign(new Error('Gemini is not configured. Add GEMINI_API_KEY in Coolify.'), { status: 503 });
  const instructions = {
    title: 'Polish the candidate target job title. Return one concise title only.',
    skills: 'Improve and organize this comma-separated skills list. Use only skills already present in the supplied profile or text. Return a comma-separated list only.',
    summary: 'Write a strong, concise professional summary of 60 to 100 words for job applications.',
    application: 'Improve this job-application response so it is direct, warm, specific, and professional.'
  };
  if (!instructions[field]) throw Object.assign(new Error('Unsupported AI writing field.'), { status: 400 });
  const prompt = `${instructions[field]} Never invent employers, dates, education, credentials, achievements, metrics, or skills. Preserve the candidate's meaning and write in first person when appropriate. Return only the replacement text, with no heading or commentary.\n\nConfirmed profile: ${JSON.stringify(profile)}\n\nCurrent text: ${String(value || '').slice(0, 6000)}`;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35, maxOutputTokens: 600 } }) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw Object.assign(new Error(detail.error?.message || `Gemini returned ${response.status}`), { status: 502 });
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('Gemini returned an empty suggestion.'), { status: 502 });
  return text.replace(/^```(?:text)?\s*|\s*```$/g, '').trim();
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
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      const user = currentUser(req, data); save(data); return send(res, 200, { authenticated: Boolean(user), user, canSignUp: !data.account });
    }
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      if (data.account) return send(res, 409, { error: 'An account already exists. Sign in instead.' });
      const input = await parse(req); const name = String(input.name || '').trim(); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
      if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return send(res, 400, { error: 'Enter your name, a valid email, and a password of at least 8 characters.' });
      data.account = { name, email, passwordHash: await passwordHash(password), createdAt: new Date().toISOString() };
      data.profile = { name, email, title: '', phone: '', location: '', skills: [], summary: '', links: [] }; startSession(res, data); save(data); return send(res, 201, { user: { name, email }, onboarding: true });
    }
    if (url.pathname === '/api/auth/signin' && req.method === 'POST') {
      const input = await parse(req); const email = String(input.email || '').trim().toLowerCase();
      if (!data.account || email !== data.account.email || !await passwordMatches(String(input.password || ''), data.account.passwordHash)) return send(res, 401, { error: 'Email or password is incorrect.' });
      startSession(res, data); save(data); return send(res, 200, { user: { name: data.account.name, email: data.account.email } });
    }
    if (url.pathname === '/api/auth/signout' && req.method === 'POST') { endSession(req, res, data); save(data); return send(res, 200, { ok: true }); }
    const user = currentUser(req, data);
    if (!user) { save(data); return send(res, 401, { error: 'Sign in required.' }); }
    if (url.pathname === '/api/state') { const { account, sessions, ...safeData } = data; return send(res, 200, { ...safeData, profile: profileView(data.profile) }); }
    if (url.pathname === '/api/profile' && req.method === 'GET') return send(res, 200, profileView(data.profile));
    if (url.pathname === '/api/profile' && req.method === 'PUT') { const input = await parse(req); delete input.photoStoredName; data.profile = { ...data.profile, ...input }; save(data); return send(res, 200, profileView(data.profile)); }
    if (url.pathname === '/api/profile/photo' && req.method === 'POST') {
      const input = await parse(req, 5 * 1024 * 1024); const buffer = Buffer.from(input.data || '', 'base64'); const mime = String(input.mime || '');
      const png = mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); const jpeg = mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8;
      if (!buffer.length || buffer.length > 3 * 1024 * 1024 || (!png && !jpeg)) return send(res, 400, { error: 'Upload a PNG or JPEG image smaller than 3 MB.' });
      if (data.profile.photoStoredName) { const old = path.join(profileDir, data.profile.photoStoredName); if (fs.existsSync(old)) fs.unlinkSync(old); }
      const storedName = `photo-${crypto.randomUUID()}.${png ? 'png' : 'jpg'}`; fs.writeFileSync(path.join(profileDir, storedName), buffer); data.profile.photoStoredName = storedName; data.profile.photoMime = mime; save(data); return send(res, 201, profileView(data.profile));
    }
    if (url.pathname === '/api/profile/photo' && req.method === 'GET') { const name = data.profile.photoStoredName; const file = name && path.join(profileDir, name); if (!file || !file.startsWith(profileDir) || !fs.existsSync(file)) return send(res, 404, { error: 'Profile photo not found.' }); res.writeHead(200, { 'content-type': data.profile.photoMime || 'image/jpeg', 'cache-control': 'private, max-age=300' }); return fs.createReadStream(file).pipe(res); }
    if (url.pathname === '/api/ai/status' && req.method === 'GET') return send(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), provider: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    if (url.pathname === '/api/ai/assist' && req.method === 'POST') {
      const input = await parse(req);
      const text = await assistWithGemini(input.field, input.value, data.profile);
      return send(res, 200, { text, provider: 'gemini' });
    }

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
      data.resumes.unshift(resume); if (!data.profile.sourceResumeId) data.profile.sourceResumeId = resume.id; save(data);
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
      if (!source) return send(res, 400, { error: 'Import and select a master resume before approving a job.' });
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
      if (!source) return send(res, 400, { error: 'Import and select a master resume before tailoring.' });
      const result = await generateResume(data.profile, job, source); application.status = 'resume_ready'; application.resume = { version: `${application.company} — tailored resume`, generatedAt: new Date().toISOString(), ...result }; save(data); return send(res, 200, application);
    }
    if (parts[1] === 'applications' && parts[3] === 'download' && req.method === 'GET') {
      const application = data.applications.find(item => item.id === parts[2]); if (!application?.resume?.text) return send(res, 404, { error: 'Tailored resume not ready' });
      const format = url.searchParams.get('format') || 'docx'; const base = `${safeName(application.company)}-${safeName(application.title)}-resume`;
      if (format === 'docx') { const buffer = await atsDocx(application, data.profile); res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-disposition': `attachment; filename="${base}-ATS.docx"` }); return res.end(buffer); }
      if (format === 'pdf') { const photo = data.profile.photoStoredName ? path.join(profileDir, data.profile.photoStoredName) : ''; const buffer = await visualPdf(application, data.profile, photo); res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${base}-visual.pdf"` }); return res.end(buffer); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${base}.txt"` }); return res.end(application.resume.text);
    }
    if (url.pathname === '/api/integrations' && req.method === 'GET') return send(res, 200, data.integrations);
    if (parts[1] === 'integrations' && parts[3] === 'connect' && req.method === 'POST') { const integration = data.integrations.find(item => item.id === parts[2]); if (!integration) return send(res, 404, { error: 'Integration not found' }); integration.connectedAt = new Date().toISOString(); integration.status = integration.url ? 'browser_handoff' : 'needs_credentials'; save(data); return send(res, 200, integration); }
    if (url.pathname === '/api/runs' && req.method === 'GET') return send(res, 200, data.runs);
    if (url.pathname === '/api/runs' && req.method === 'POST') { const found = await discover(data); const run = { id: crypto.randomUUID(), status: 'completed', found, startedAt: new Date().toISOString() }; data.runs.unshift(run); save(data); return send(res, 201, run); }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error); return send(res, error.status || 400, { error: error.message || 'Request failed' }); }
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
