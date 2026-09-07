import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeProjectImage } from "../server/imageStore";

async function testDirectory(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "diariomaker-image-test-"));
  t.after(async () => {
    // Only delete direct test files in this exact, newly created directory.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("diariomaker-image-test-"));
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  });
  return directory;
}

test("concurrent active/version/archive saves create a single physical image", async t => {
  const directory = await testDirectory(t);
  const bytes = Buffer.from("same-image-content");
  const results = await Promise.all(Array.from({ length: 12 }, () => storeProjectImage(directory, bytes, ".png")));
  assert.equal(new Set(results).size, 1);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, results[0])), bytes);
});

test("legacy identical files are reused, not renamed or removed", async t => {
  const directory = await testDirectory(t);
  const bytes = Buffer.from("old-image");
  await fs.writeFile(path.join(directory, "cena_01_legacy.png"), bytes);
  const name = await storeProjectImage(directory, bytes, ".png");
  assert.equal(name, "cena_01_legacy.png");
  assert.deepEqual(await fs.readdir(directory), [name]);
});

test("different bytes of equal size remain different images", async t => {
  const directory = await testDirectory(t);
  const first = await storeProjectImage(directory, Buffer.from("image-A"), ".png");
  const second = await storeProjectImage(directory, Buffer.from("image-B"), ".png");
  assert.notEqual(first, second);
  assert.equal((await fs.readdir(directory)).length, 2);
});
