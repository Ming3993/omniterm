import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from './gitDiff.js';

describe('gitDiff', () => {
  describe('parseUnifiedDiff', () => {
    it('returns empty array on empty diff', () => {
      assert.deepEqual(parseUnifiedDiff(''), []);
      assert.deepEqual(parseUnifiedDiff('   \n  '), []);
    });

    it('parses single modified file with additions and deletions', () => {
      const sample = `diff --git a/src/hello.ts b/src/hello.ts
index 83db48f..bf269f4 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,5 +1,6 @@
 import os from 'os';
-const oldVar = 1;
+const newVar = 2;
+const extraVar = 3;
 export default {};
`;
      const files = parseUnifiedDiff(sample);
      assert.equal(files.length, 1);
      const file = files[0];
      assert.equal(file.file, 'src/hello.ts');
      assert.equal(file.status, 'modified');
      assert.equal(file.additions, 2);
      assert.equal(file.deletions, 1);

      // Verify lines
      const delLine = file.lines.find((l) => l.type === 'del');
      assert.ok(delLine);
      assert.equal(delLine.content, 'const oldVar = 1;');
      assert.equal(delLine.oldLineNo, 2);

      const addLines = file.lines.filter((l) => l.type === 'add');
      assert.equal(addLines.length, 2);
      assert.equal(addLines[0].content, 'const newVar = 2;');
      assert.equal(addLines[0].newLineNo, 2);
      assert.equal(addLines[1].content, 'const extraVar = 3;');
      assert.equal(addLines[1].newLineNo, 3);
    });

    it('parses new file mode as added', () => {
      const sample = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..bf269f4
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line 1
+line 2
`;
      const files = parseUnifiedDiff(sample);
      assert.equal(files.length, 1);
      assert.equal(files[0].file, 'new.txt');
      assert.equal(files[0].status, 'added');
      assert.equal(files[0].additions, 2);
      assert.equal(files[0].deletions, 0);
    });
  });
});
