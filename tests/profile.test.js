const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const db = require('../dist/db');
const { validateProfile, saveProfile } = require('../dist/users/profile.service');

test('profile validates fields and normalizes avatar without metadata', async () => {
  for (const body of [null, { display_name: '' }, { display_name: 'x'.repeat(101) }, { display_name: 'Name', role: 'admin' }, { display_name: 'Name', avatar: 'not-an-image' }, { display_name: 'Name', avatar: 'A'.repeat(90001) }]) {
    await assert.rejects(validateProfile(body), { statusCode: 400 });
  }
  const raw = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await validateProfile({ display_name: '  Person  ', avatar: raw.toString('base64') });
  assert.equal(result.name, 'Person');
  const metadata = await sharp(result.avatar).metadata();
  assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined);
  const oversized = await sharp({ create: { width: 1100, height: 1100, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(validateProfile({ display_name: 'Person', avatar: oversized.toString('base64') }), { statusCode: 400 });
});

test('profile saves atomically for current passenger and supports removal', async t => {
  const original = db.getClient;
  t.after(() => { db.getClient = original; });
  let permitted = true, fail = false, calls = [];
  db.getClient = async () => ({ release() {}, async query(sql, args) {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT')) return { rows: permitted ? [{ id: 'current-user' }] : [] };
    if (sql.startsWith('UPDATE users')) { if (fail) throw Error('write failed'); return { rows: [{ id: 'current-user', display_name: args[1], photo_url: null }] }; }
    return { rows: [] };
  } });
  const user = await saveProfile('current-user', { display_name: 'Updated', avatar: null });
  assert.equal(user.display_name, 'Updated');
  assert.ok(calls.some(c => c.sql.startsWith('DELETE FROM user_avatars') && c.args[0] === 'current-user'));
  assert.ok(calls.some(c => c.sql === 'COMMIT'));
  calls = []; permitted = false;
  await assert.rejects(saveProfile('current-user', { display_name: 'Updated' }), { statusCode: 403 });
  assert.ok(!calls.some(c => c.sql.startsWith('UPDATE')));
  assert.ok(calls.some(c => c.sql === 'ROLLBACK'));
  calls = []; permitted = true; fail = true;
  await assert.rejects(saveProfile('current-user', { display_name: 'Updated', avatar: null }));
  assert.ok(calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(!calls.some(c => c.sql === 'COMMIT'));
});
