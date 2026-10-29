import { expect, test } from 'bun:test';
import { parseUnifiedDiff } from './diff';
import {
	acceptsReasonedDecline,
	chatReplyPolicy,
	defersToGuidelineChange,
	isTrustedCommenter
} from './chat-policy';
import { changedGuidelineFiles } from './tools';

const note = { severity: 'minor', category: 'testing' };

test('only owner, member, and collaborator count as trusted commenters', () => {
	for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
		expect(isTrustedCommenter(association)).toBe(true);
	}
	for (const association of ['CONTRIBUTOR', 'NONE', 'MANNEQUIN', '', undefined]) {
		expect(isTrustedCommenter(association)).toBe(false);
	}
});

test('a reasoned decline is accepted only for a trusted commenter on a minor non-defect note', () => {
	for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
		expect(acceptsReasonedDecline(association, { severity: 'minor', category: 'testing' })).toBe(
			true
		);
		expect(
			acceptsReasonedDecline(association, { severity: 'info', category: 'documentation' })
		).toBe(true);
		expect(
			acceptsReasonedDecline(association, { severity: 'minor', category: 'maintainability' })
		).toBe(true);
	}

	expect(acceptsReasonedDecline('MEMBER', { severity: 'minor', category: 'bug' })).toBe(false);
	expect(acceptsReasonedDecline('MEMBER', { severity: 'minor', category: 'security' })).toBe(false);
	expect(acceptsReasonedDecline('MEMBER', { severity: 'minor', category: 'concurrency' })).toBe(
		false
	);
	expect(acceptsReasonedDecline('MEMBER', { severity: 'info', category: 'error-handling' })).toBe(
		false
	);
	expect(acceptsReasonedDecline('MEMBER', { severity: 'major', category: 'testing' })).toBe(false);
	expect(acceptsReasonedDecline('MEMBER', { severity: 'minor', category: 'performance' })).toBe(
		false
	);
	expect(acceptsReasonedDecline('CONTRIBUTOR', note)).toBe(false);
	expect(acceptsReasonedDecline('NONE', { severity: 'info', category: 'documentation' })).toBe(
		false
	);
	expect(acceptsReasonedDecline('MEMBER', undefined)).toBe(false);
});

test('a guideline edit defers a non-defect finding only for a trusted commenter', () => {
	expect(defersToGuidelineChange('MEMBER', note)).toBe(true);
	expect(
		defersToGuidelineChange('COLLABORATOR', { severity: 'major', category: 'performance' })
	).toBe(true);
	expect(defersToGuidelineChange('OWNER', { severity: 'info', category: 'documentation' })).toBe(
		true
	);
	expect(defersToGuidelineChange('OWNER', { severity: 'minor', category: 'bug' })).toBe(false);
	expect(defersToGuidelineChange('OWNER', { severity: 'critical', category: 'security' })).toBe(
		false
	);
	expect(defersToGuidelineChange('OWNER', { severity: 'minor', category: 'concurrency' })).toBe(
		false
	);
	expect(defersToGuidelineChange('MEMBER', { severity: 'major', category: 'error-handling' })).toBe(
		false
	);
	expect(defersToGuidelineChange('CONTRIBUTOR', note)).toBe(false);
	expect(defersToGuidelineChange('NONE', note)).toBe(false);
	expect(defersToGuidelineChange('MEMBER', undefined)).toBe(false);
});

test('the prompt policy combines trust, category, and whether a guideline file changed', () => {
	expect(
		chatReplyPolicy({
			authorAssociation: 'MEMBER',
			finding: note,
			changedGuidelines: ['AGENTS.md']
		})
	).toEqual({
		acceptReasonedDecline: true,
		holdDefect: false,
		acceptDeliberateChange: false,
		deferToGuidelineEdit: true
	});
	expect(
		chatReplyPolicy({
			authorAssociation: 'OWNER',
			finding: { severity: 'major', category: 'bug' },
			changedGuidelines: ['AGENTS.md']
		})
	).toEqual({
		acceptReasonedDecline: false,
		holdDefect: true,
		acceptDeliberateChange: true,
		deferToGuidelineEdit: false
	});
	expect(
		chatReplyPolicy({
			authorAssociation: 'CONTRIBUTOR',
			finding: note,
			changedGuidelines: ['AGENTS.md']
		})
	).toEqual({
		acceptReasonedDecline: false,
		holdDefect: false,
		acceptDeliberateChange: false,
		deferToGuidelineEdit: false
	});
	expect(chatReplyPolicy({ authorAssociation: 'MEMBER', finding: note })).toEqual({
		acceptReasonedDecline: true,
		holdDefect: false,
		acceptDeliberateChange: false,
		deferToGuidelineEdit: false
	});
});

const agentsDiff = `diff --git a/AGENTS.md b/AGENTS.md
index 1111111..2222222 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1,2 +1,3 @@
 # Guidelines
+- Contract locks may live in tests/unit.
 Tests live next to the code.
diff --git a/src/math.ts b/src/math.ts
index 3333333..4444444 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
diff --git a/packages/foo/AGENTS.md b/packages/foo/AGENTS.md
index 5555555..6666666 100644
--- a/packages/foo/AGENTS.md
+++ b/packages/foo/AGENTS.md
@@ -1 +1 @@
-old
+new
`;

test('only the repository guideline files count as a policy change', () => {
	expect(changedGuidelineFiles(parseUnifiedDiff(agentsDiff))).toEqual(['AGENTS.md']);
	expect(changedGuidelineFiles([])).toEqual([]);
	expect(
		changedGuidelineFiles([
			{ path: 'CLAUDE.md' },
			{ path: 'README.md', oldPath: 'CONTRIBUTING.md' },
			{ path: '.github/copilot-instructions.md' }
		])
	).toEqual(['CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md']);
});

test('a trusted commenter can settle a deliberate change, except on a security finding', () => {
	expect(
		chatReplyPolicy({
			authorAssociation: 'MEMBER',
			finding: { severity: 'major', category: 'bug' }
		}).acceptDeliberateChange
	).toBe(true);
	expect(
		chatReplyPolicy({
			authorAssociation: 'OWNER',
			finding: { severity: 'critical', category: 'security' }
		}).acceptDeliberateChange
	).toBe(false);
	expect(
		chatReplyPolicy({
			authorAssociation: 'CONTRIBUTOR',
			finding: { severity: 'major', category: 'bug' }
		}).acceptDeliberateChange
	).toBe(false);
});
