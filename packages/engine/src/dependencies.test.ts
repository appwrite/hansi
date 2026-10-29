import { describe, expect, test } from 'bun:test';
import { dependencyChanges, isMajorBump } from './dependencies';
import { parseUnifiedDiff } from './diff';
import { filterFiles } from './filters';

const changes = (diff: string) =>
	dependencyChanges(parseUnifiedDiff(diff)).map(({ name, from, to }) => ({ name, from, to }));

describe('dependencyChanges', () => {
	test('reads composer.lock bumps', () => {
		expect(
			changes(`diff --git a/composer.lock b/composer.lock
--- a/composer.lock
+++ b/composer.lock
@@ -10,4 +10,4 @@
         {
             "name": "symfony/console",
-            "version": "v6.4.1",
+            "version": "v7.1.0",
             "source": {
@@ -40,4 +40,4 @@
             "name": "psr/log",
-            "version": "3.0.0",
+            "version": "3.0.2",
             "source": {
`)
		).toEqual([
			{ name: 'symfony/console', from: 'v6.4.1', to: 'v7.1.0' },
			{ name: 'psr/log', from: '3.0.0', to: '3.0.2' }
		]);
	});

	test('reads package-lock.json, bun.lock, and go.sum', () => {
		expect(
			changes(`diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -20,3 +20,3 @@
     "node_modules/@types/node": {
-      "version": "20.1.0",
+      "version": "22.0.0",
diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -50,2 +50,3 @@
-    "zod": ["zod@3.23.8", "", {}, "sha512-a"],
+    "zod": ["zod@4.0.1", "", {}, "sha512-b"],
+    "@scope/new": ["@scope/new@1.0.0", "", {}, "sha512-c"],
diff --git a/go.sum b/go.sum
--- a/go.sum
+++ b/go.sum
@@ -1,2 +1,2 @@
-github.com/pkg/errors v0.8.1 h1:abc=
-github.com/pkg/errors v0.8.1/go.mod h1:def=
+github.com/pkg/errors v0.9.1 h1:ghi=
+github.com/pkg/errors v0.9.1/go.mod h1:jkl=
`)
		).toEqual([
			{ name: '@types/node', from: '20.1.0', to: '22.0.0' },
			{ name: 'zod', from: '3.23.8', to: '4.0.1' },
			{ name: '@scope/new', from: null, to: '1.0.0' },
			{ name: 'github.com/pkg/errors', from: 'v0.8.1', to: 'v0.9.1' }
		]);
	});

	test('reads yarn.lock, Cargo.lock, and Gemfile.lock', () => {
		expect(
			changes(`diff --git a/yarn.lock b/yarn.lock
--- a/yarn.lock
+++ b/yarn.lock
@@ -1,3 +1,3 @@
 "@babel/core@^7.0.0", "@babel/core@^7.1.0":
-  version "7.20.0"
+  version "7.24.0"
   resolved "https://registry.yarnpkg.com/x"
diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1,4 +1,4 @@
 [[package]]
 name = "serde"
-version = "1.0.190"
+version = "1.0.210"
diff --git a/Gemfile.lock b/Gemfile.lock
--- a/Gemfile.lock
+++ b/Gemfile.lock
@@ -1,3 +1,3 @@
-    rails (7.0.8)
+    rails (7.1.3)
       actionpack (= 7.1.3)
`)
		).toEqual([
			{ name: '@babel/core', from: '7.20.0', to: '7.24.0' },
			{ name: 'serde', from: '1.0.190', to: '1.0.210' },
			{ name: 'rails', from: '7.0.8', to: '7.1.3' }
		]);
	});

	test('ignores files that are not lockfiles', () => {
		expect(
			changes(`diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-  "version": "1.0.0",
+  "version": "1.1.0",
`)
		).toEqual([]);
	});
});

test('isMajorBump treats a new major, or a new minor before 1.0, as breaking', () => {
	expect(isMajorBump('6.5.8', '7.0.0')).toBe(true);
	expect(isMajorBump('v0.8.1', 'v0.9.1')).toBe(true);
	expect(isMajorBump('1.2.0', '1.9.0')).toBe(false);
	expect(isMajorBump('7.0.0', '6.0.0')).toBe(false);
	expect(isMajorBump('abc', 'def')).toBe(false);
});

test('filterFiles keeps lockfiles, snapshots, and generated code only with a sandbox', () => {
	const files = parseUnifiedDiff(`diff --git a/composer.lock b/composer.lock
--- a/composer.lock
+++ b/composer.lock
@@ -1 +1 @@
-a
+b
diff --git a/src/__snapshots__/app.test.ts.snap b/src/__snapshots__/app.test.ts.snap
--- a/src/__snapshots__/app.test.ts.snap
+++ b/src/__snapshots__/app.test.ts.snap
@@ -1 +1 @@
-a
+b
diff --git a/api/v1/api.pb.go b/api/v1/api.pb.go
--- a/api/v1/api.pb.go
+++ b/api/v1/api.pb.go
@@ -1 +1 @@
-a
+b
diff --git a/dist/app.js b/dist/app.js
--- a/dist/app.js
+++ b/dist/app.js
@@ -1 +1 @@
-a
+b
`);
	expect(filterFiles(files).included).toEqual([]);
	const withSandbox = filterFiles(files, [], { sandbox: true });
	expect(withSandbox.included.map((f) => f.path)).toEqual([
		'composer.lock',
		'src/__snapshots__/app.test.ts.snap',
		'api/v1/api.pb.go'
	]);
	expect(withSandbox.excluded).toEqual([{ path: 'dist/app.js', reason: 'ignored by default' }]);
	expect(
		filterFiles(files, ['!composer.lock'], { sandbox: true }).included.map((f) => f.path)
	).not.toContain('composer.lock');
});
