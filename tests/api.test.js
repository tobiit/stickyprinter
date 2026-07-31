'use strict';

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickyprinter-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';

const app = require('../src/server');

let agent; // Supertest agent for cookies
let workshopCode;
let participantToken;
let stickyId;

beforeAll(() => {
  agent = request.agent(app);
});

afterAll(() => {
  // Clean up temp DB
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
});

describe('Auth', () => {
  test('register a moderator', async () => {
    const res = await agent.post('/api/auth/register').send({ username: 'testmod', password: 'pass1234' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('testmod');
  });

  test('login with wrong password returns 401', async () => {
    const res = await agent.post('/api/auth/login').send({ username: 'testmod', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('login with correct credentials', async () => {
    const res = await agent.post('/api/auth/login').send({ username: 'testmod', password: 'pass1234' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('testmod');
  });

  test('get current user', async () => {
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('testmod');
  });

  test('duplicate username returns 409', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'testmod', password: 'pass1234' });
    expect(res.status).toBe(409);
  });
});

describe('Workshops', () => {
  test('create a workshop (moderator)', async () => {
    const res = await agent.post('/api/workshops').send({ name: 'Test Workshop' });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^WS-[A-Z]{4}-\d{4}$/);
    expect(res.body.name).toBe('Test Workshop');
    expect(res.body.autoprint).toBe(false);
    workshopCode = res.body.code;
  });

  test('list workshops returns our workshop', async () => {
    const res = await agent.get('/api/workshops');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some(w => w.code === workshopCode)).toBe(true);
  });

  test('get workshop by code (public)', async () => {
    const res = await request(app).get(`/api/workshops/${workshopCode}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(workshopCode);
  });

  test('get non-existent workshop returns 404', async () => {
    const res = await request(app).get('/api/workshops/WS-ZZZZ-9999');
    expect(res.status).toBe(404);
  });

  test('set autoprint', async () => {
    const res = await agent.put(`/api/workshops/${workshopCode}/autoprint`).send({ autoprint: true });
    expect(res.status).toBe(200);
    expect(res.body.autoprint).toBe(true);
    // Disable again
    await agent.put(`/api/workshops/${workshopCode}/autoprint`).send({ autoprint: false });
  });

  test('creating workshop requires moderator auth', async () => {
    const res = await request(app).post('/api/workshops').send({ name: 'Unauthorized' });
    expect(res.status).toBe(401);
  });
});

describe('Participants', () => {
  let participantAgent;

  beforeAll(() => {
    participantAgent = request.agent(app);
  });

  test('join a workshop', async () => {
    const res = await participantAgent.post(`/api/workshops/${workshopCode}/join`).send({ name: 'Alice' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.participant.name).toBe('Alice');
    participantToken = res.body.token;
  });

  test('join with non-existent code returns 404', async () => {
    const res = await request(app).post('/api/workshops/WS-ZZZZ-9999/join').send({ name: 'Bob' });
    expect(res.status).toBe(404);
  });

  test('join without name returns 400', async () => {
    const res = await request(app).post(`/api/workshops/${workshopCode}/join`).send({});
    expect(res.status).toBe(400);
  });
});

describe('Stickies', () => {
  let participantAgent;

  beforeAll(() => {
    participantAgent = request.agent(app);
  });

  test('setup: join workshop as Bob', async () => {
    const res = await participantAgent.post(`/api/workshops/${workshopCode}/join`).send({ name: 'Bob' });
    expect(res.status).toBe(201);
    participantToken = res.body.token;
  });

  test('create a sticky', async () => {
    const res = await participantAgent.post('/api/stickies');
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('draft');
    stickyId = res.body.id;
  });

  test('list my stickies', async () => {
    const res = await participantAgent.get('/api/stickies/mine');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('update a sticky', async () => {
    const res = await participantAgent.put(`/api/stickies/${stickyId}`).send({
      content: 'Hello from Bob!',
      image_data: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Hello from Bob!');
  });

  test('get sticky by id', async () => {
    const res = await participantAgent.get(`/api/stickies/${stickyId}`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Hello from Bob!');
  });

  test('submit a sticky', async () => {
    const res = await participantAgent.post(`/api/stickies/${stickyId}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
  });

  test('cannot update submitted sticky', async () => {
    const res = await participantAgent.put(`/api/stickies/${stickyId}`).send({ content: 'Changed' });
    expect(res.status).toBe(409);
  });

  test('cannot delete submitted sticky', async () => {
    const res = await participantAgent.delete(`/api/stickies/${stickyId}`);
    expect(res.status).toBe(409);
  });

  test('cannot re-submit an already submitted sticky', async () => {
    const res = await participantAgent.post(`/api/stickies/${stickyId}/submit`);
    expect(res.status).toBe(409);
  });

  test('moderator can list submitted stickies', async () => {
    const res = await agent.get(`/api/stickies/workshop/${workshopCode}?status=submitted`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const found = res.body.find(s => s.id === stickyId);
    expect(found).toBeTruthy();
    expect(found.participant_name).toBe('Bob');
  });

  test('moderator can view sticky with workshop_code', async () => {
    const res = await agent.get(`/api/stickies/${stickyId}`);
    expect(res.status).toBe(200);
    expect(res.body.workshop_code).toBe(workshopCode);
    expect(res.body.participant_name).toBe('Bob');
  });

  test('moderator can reject a sticky', async () => {
    const res = await agent.post(`/api/stickies/${stickyId}/reject`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
  });

  test('participant can re-submit rejected sticky', async () => {
    const res = await participantAgent.post(`/api/stickies/${stickyId}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
  });

  test('moderator can print sticky (stub)', async () => {
    const res = await agent.post(`/api/stickies/${stickyId}/print`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('printed');
    expect(res.body.print_result).toBeTruthy();
  });

  test('create and delete a draft sticky', async () => {
    const create = await participantAgent.post('/api/stickies');
    expect(create.status).toBe(201);
    const del = await participantAgent.delete(`/api/stickies/${create.body.id}`);
    expect(del.status).toBe(200);
  });
});

describe('Moderator Workshop Stickies filter', () => {
  test('cannot access other moderator workshop stickies', async () => {
    // Create another moderator and their workshop
    const other = request.agent(app);
    await other.post('/api/auth/register').send({ username: 'othermod', password: 'pass5678' });
    const ws = await other.post('/api/workshops').send({ name: 'Other Workshop' });
    const otherCode = ws.body.code;
    // original moderator should not be able to access other's stickies
    const res = await agent.get(`/api/stickies/workshop/${otherCode}`);
    expect(res.status).toBe(403);
  });
});
