import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushRejection, redactToken } from '../server/git.ts';

const refused = `git -c http.https://github.com/.extraheader=AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0 push failed (1): To https://github.com/o/r.git
 ! [remote rejected] HEAD -> feature/x (refusing to allow an OAuth App to create or update workflow \`.github/workflows/b.yaml\` without \`workflow\` scope)
error: failed to push some refs to 'https://github.com/o/r.git'`;

test('the auth header of a failed git command never reaches an error text', () => {
  const text = redactToken(refused);
  assert.ok(!text.includes('eC1hY2Nlc3'));
  assert.ok(text.includes('AUTHORIZATION: basic ***'));
});

test('a refused push yields its reason, any other failure none', () => {
  assert.equal(
    pushRejection(refused),
    'refusing to allow an OAuth App to create or update workflow `.github/workflows/b.yaml` without `workflow` scope',
  );
  assert.equal(pushRejection('fatal: unable to access: Could not resolve host'), null);
  assert.equal(pushRejection('! [rejected] HEAD -> x (stale info)'), null);
});
