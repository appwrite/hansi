import { expect, test } from 'bun:test';
import { isBotAuthor, repliesToBot } from './chat-reply';

const mention = '@hansi-codes';
const bot = (id: number) => ({ id, author: 'hansi-codes[bot]', isBot: true });
const human = (id: number, author = 'ChiragAgg5k') => ({ id, author, isBot: false });

test('the bot is recognised by its app login', () => {
	expect(isBotAuthor(bot(1), mention)).toBe(true);
	expect(isBotAuthor({ author: 'Hansi-Codes[bot]', isBot: true }, mention)).toBe(true);
	expect(isBotAuthor({ author: 'cursor[bot]', isBot: true }, mention)).toBe(false);
	// A person who picked the same name is not the bot.
	expect(isBotAuthor({ author: 'hansi-codes', isBot: false }, mention)).toBe(false);
});

test('a reply on a thread the bot started is for the bot', () => {
	expect(repliesToBot([bot(1), human(2)], 2, mention)).toBe(true);
	// Later replies in the same finding thread too, even after other people spoke.
	expect(repliesToBot([bot(1), human(2), human(3, 'eldadfux'), human(4)], 4, mention)).toBe(true);
});

test('a reply right after the bot answered in a thread a person started is for the bot', () => {
	expect(repliesToBot([human(1), bot(2), human(3)], 3, mention)).toBe(true);
});

test('people talking in a thread the bot never joined stays quiet', () => {
	expect(repliesToBot([human(1), human(2, 'eldadfux')], 2, mention)).toBe(false);
	expect(repliesToBot([human(1), bot(2), human(3), human(4, 'eldadfux')], 4, mention)).toBe(false);
	expect(repliesToBot([], 2, mention)).toBe(false);
});

test('another app in the thread does not count as the bot', () => {
	const other = { id: 2, author: 'cursor[bot]', isBot: true };
	expect(repliesToBot([human(1), other, human(3)], 3, mention)).toBe(false);
});
