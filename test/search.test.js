import assert from 'node:assert/strict';
import test from 'node:test';

import { findRankedItems, tokenize } from '../tools/search_utils.js';

const items = [
    { Name: 'TradeServer', Path: 'ServerScriptService.TradeServer' },
    { Name: 'TradingClient', Path: 'StarterPlayer.StarterPlayerScripts.Modules.TradingClient' },
    { Name: 'TradeEvent', Path: 'ReplicatedStorage.Events.TradeEvent' },
    { Name: 'CurrencyService', Path: 'ServerScriptService.CurrencyService' }
];

test('normalizes trade and trading to the same search root', () => {
    assert.deepEqual(tokenize('systems with trading'), ['trade']);
});

test('system trade finds both trade and trading components', () => {
    const names = findRankedItems(items, 'system trade').map(result => result.item.Name);
    assert.deepEqual(names, ['TradeEvent', 'TradeServer', 'TradingClient']);
});

test('generic query words do not create unrelated matches', () => {
    const names = findRankedItems(items, 'system with trade').map(result => result.item.Name);
    assert.equal(names.includes('CurrencyService'), false);
});
