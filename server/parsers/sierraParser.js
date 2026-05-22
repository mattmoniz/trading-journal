export function parseSierraTradeLog(content) {
  const lines = content.split('\n').filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error('Invalid Sierra Chart file: no data rows found');
  }

  // Auto-detect delimiter: tab or comma
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = tabCount >= commaCount ? '\t' : ',';

  const headers = firstLine.split(delimiter).map(h => h.trim());
  console.log('📋 Sierra Chart columns found:', headers.length, 'columns');
  console.log('📋 First few headers:', headers.slice(0, 5).join(', '));
  console.log(`📋 Delimiter detected: ${delimiter === '\t' ? 'TAB' : 'COMMA'}`);

  // Detect format type
  const isActivityLog = headers.includes('ActivityType');
  const isTradeSummary = headers.includes('Trade Type') && headers.includes('Entry DateTime');
  const hasPnlColumns = headers.includes('FlatToFlat Profit/Loss (C)') && headers.includes('Cumulative Profit/Loss (C)');

  const formatType = isTradeSummary ? 'TAL' : isActivityLog ? 'ActivityLog' : 'Unknown';
  console.log(`📊 Detected format: ${formatType}`);

  if (isActivityLog) console.warn('⚠️  Activity Log format — no P&L data.');
  else if (isTradeSummary && !hasPnlColumns) console.warn('⚠️  Trade Summary missing FlatToFlat/CumPL columns.');

  const trades = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = lines[i].split(delimiter);

      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index]?.trim() || '';
      });

      let trade;
      if (isTradeSummary) {
        trade = mapTradeSummaryToSchema(row, i, headers);
      } else if (isActivityLog) {
        // Only process "Fills" activity type
        if (row['ActivityType'] !== 'Fills') {
          continue;
        }
        trade = mapSierraTradeToSchema(row, i, headers);
      } else {
        console.warn('⚠️ Unknown file format, skipping');
        break;
      }

      if (trade) {
        trades.push(trade);
      }

    } catch (error) {
      console.error(`❌ Error parsing row ${i}:`, error.message);
    }
  }

  // Deduplicate within the parsed batch: Sierra Chart CSV can include the same
  // fill twice (once with BP/EP markers, once without). Always preserve BP and
  // EP marked fills; only dedup unmarked fills that share an identical key.
  const hasMarker = t => {
    const entryDT = t.custom_fields?.sierra_data?.['Entry DateTime'] || '';
    const exitDT  = t.custom_fields?.sierra_data?.['Exit DateTime']  || '';
    return / BP$/i.test(entryDT.trim()) || / EP$/i.test(exitDT.trim());
  };
  const seen = new Set();
  const dedupedTrades = [];
  for (const t of trades) {
    const account = t.custom_fields?.account ?? null;
    const key = `${t.entry_time}|${t.exit_time}|${t.symbol}|${t.direction}|${t.quantity}|${t.entry_price}|${t.exit_price}|${account}`;
    if (hasMarker(t)) {
      // Always keep BP/EP-marked fills — they carry session boundary information
      dedupedTrades.push(t);
    } else if (!seen.has(key)) {
      seen.add(key);
      dedupedTrades.push(t);
    }
  }
  if (dedupedTrades.length < trades.length) {
    console.log(`🔄 Removed ${trades.length - dedupedTrades.length} intra-file duplicate fills`);
  }

  console.log(`✅ Parsed ${dedupedTrades.length} trades from Sierra Chart file`);
  return {
    trades: dedupedTrades,
    formatType,
    hasPnl: isTradeSummary && hasPnlColumns,
    warning: isActivityLog
      ? 'Activity Log format detected — no P&L data. Export Trade Activity Log Summary instead (Entry DateTime / FlatToFlat Profit/Loss columns required).'
      : null,
  };
}

function mapTradeSummaryToSchema(row, rowNumber, headers) {
  try {
    // Trade Summary format has: Entry DateTime, Exit DateTime, Entry Price, Exit Price, Profit/Loss, etc.
    const entryDateTime = parseDateTime(row['Entry DateTime']);
    const exitDateTime = parseDateTime(row['Exit DateTime']);
    const symbol = row['Symbol'];
    const tradeType = row['Trade Type'];
    const quantity = parseFloat(row['Trade Quantity']) || 0;
    const entryPrice = parseFloat(row['Entry Price']) || 0;
    const exitPrice = parseFloat(row['Exit Price']) || 0;
    const profitLoss = parseFloat(row['Profit/Loss (C)']) || 0;

    if (!entryDateTime || !symbol || !tradeType) {
      console.warn(`⚠️ Skipping row ${rowNumber}: missing required fields`);
      return null;
    }

    if (quantity === 0 || entryPrice === 0) {
      console.warn(`⚠️ Skipping row ${rowNumber}: invalid quantity or price`);
      return null;
    }

    // Normalize trade type
    const direction = tradeType.toUpperCase().includes('LONG') ? 'LONG' : 'SHORT';

    // Capture all fields in custom_fields
    const allSierraData = {};
    headers.forEach(header => {
      const value = row[header];
      if (value && value !== '') {
        allSierraData[header] = value;
      }
    });

    return {
      log_date: entryDateTime.split('T')[0],
      entry_time: entryDateTime,
      exit_time: exitDateTime || entryDateTime,
      symbol: cleanSymbol(symbol),
      direction: direction,
      quantity: Math.abs(quantity),
      entry_price: entryPrice,
      exit_price: exitPrice || entryPrice,
      pnl: profitLoss,
      fees: 0,
      custom_fields: {
        sierra_data: allSierraData,
        format_type: 'trade_summary',
        max_open_quantity: row['Max Open Quantity'],
        max_closed_quantity: row['Max Closed Quantity'],
        cumulative_pl: row['Cumulative Profit/Loss (C)'],
        flat_to_flat_pl: row['FlatToFlat Profit/Loss (C)'],
        max_open_profit: row['Max Open Profit (C)'],
        max_open_loss: row['Max Open Loss (C)'],
        entry_efficiency: row['Entry Efficiency'],
        exit_efficiency: row['Exit Efficiency'],
        total_efficiency: row['Total Efficiency'],
        high_price: row['High Price While Open'],
        low_price: row['Low Price While Open'],
        note: row['Note'],
        duration: row['Duration'],
        account: row['Account'],
        exchange: extractExchange(symbol),
        sierra_import: true,
        imported_at: new Date().toISOString(),
        sierra_row: rowNumber
      }
    };

  } catch (error) {
    console.error(`❌ Error mapping Trade Summary row ${rowNumber}:`, error);
    return null;
  }
}

function mapSierraTradeToSchema(sierraRow, rowNumber, headers) {
  try {
    // Sierra Chart columns: DateTime, Symbol, BuySell, Quantity, FillPrice
    const dateTime = parseDateTime(sierraRow['DateTime']);
    const symbol = sierraRow['Symbol'];
    const type = normalizeTradeType(sierraRow['BuySell']);
    const quantity = parseFloat(sierraRow['Quantity']) || 0;
    // Sierra Chart Activity Log stores prices scaled by 100 (e.g. 2443275 = 24432.75)
    const price = (parseFloat(sierraRow['FillPrice']) || 0) / 100;

    if (!dateTime || !symbol || !type) {
      console.warn(`⚠️ Skipping row ${rowNumber}: missing required fields`);
      return null;
    }

    if (quantity === 0 || price === 0) {
      console.warn(`⚠️ Skipping row ${rowNumber}: invalid quantity or price`);
      return null;
    }

    // Calculate P&L if available
    // Activity Log format does not carry reliable per-fill P&L — leave null
    // (P&L for these accounts must come from TAL format with CumPL diff)
    const profitLoss = null;

    // Capture ALL Sierra Chart columns in custom_fields
    const allSierraData = {};
    headers.forEach(header => {
      const value = sierraRow[header];
      if (value && value !== '') {
        allSierraData[header] = value;
      }
    });

    return {
      log_date: dateTime.split('T')[0],
      entry_time: dateTime,
      exit_time: dateTime,
      symbol: cleanSymbol(symbol),
      direction: type,
      quantity: Math.abs(quantity),
      entry_price: price,
      exit_price: price,
      pnl: profitLoss,
      fees: 0,
      custom_fields: {
        // Store ALL Sierra Chart columns
        sierra_data: allSierraData,
        
        // Also keep commonly accessed fields at top level for easy querying
        activity_type: sierraRow['ActivityType'],
        trans_datetime: sierraRow['TransDateTime'],
        order_action_source: sierraRow['OrderActionSource'],
        internal_order_id: sierraRow['InternalOrderID'],
        service_order_id: sierraRow['ServiceOrderID'],
        order_type: sierraRow['OrderType'],
        buy_sell: sierraRow['BuySell'],
        order_status: sierraRow['OrderStatus'],
        filled_quantity: sierraRow['FilledQuantity'],
        account: sierraRow['TradeAccount'],
        trade_account: sierraRow['TradeAccount'],
        open_close: sierraRow['OpenClose'],
        parent_internal_order_id: sierraRow['ParentInternalOrderID'],
        position_quantity: sierraRow['PositionQuantity'],
        fill_execution_service_id: sierraRow['FillExecutionServiceID'],
        high_during_position: sierraRow['HighDuringPosition'],
        low_during_position: sierraRow['LowDuringPosition'],
        note: sierraRow['Note'],
        account_balance: sierraRow['AccountBalance'],
        exchange_order_id: sierraRow['ExchangeOrderID'],
        client_order_id: sierraRow['ClientOrderID'],
        time_in_force: sierraRow['TimeInForce'],
        username: sierraRow['Username'],
        is_automated: sierraRow['IsAutomated'],
        price: sierraRow['Price'],
        price2: sierraRow['Price2'],
        
        // Metadata
        exchange: extractExchange(symbol),
        sierra_import: true,
        imported_at: new Date().toISOString(),
        sierra_row: rowNumber
      }
    };

  } catch (error) {
    console.error(`❌ Error mapping row ${rowNumber}:`, error);
    return null;
  }
}

function parseDateTime(dateTimeStr) {
  if (!dateTimeStr) return null;

  try {
    // Sierra Chart format: "2025-01-08  09:40:16.024149" or "2025-01-08  09:40:16.024149 BP"
    // Remove suffixes like BP (Best Price), EP (Exit Position), etc.
    let cleanDateTime = dateTimeStr.replace(/\s+(BP|EP|SP|MP)$/i, '').replace(/\s+/g, ' ').trim();
    const date = new Date(cleanDateTime);

    if (isNaN(date.getTime())) {
      console.warn(`⚠️ Invalid date format: ${dateTimeStr}`);
      return null;
    }

    return date.toISOString();
  } catch (error) {
    console.error(`❌ Error parsing date: ${dateTimeStr}`, error);
    return null;
  }
}

function normalizeTradeType(type) {
  if (!type) return null;
  
  const normalized = type.toUpperCase();
  
  if (normalized.includes('BUY') || normalized === 'B') {
    return 'LONG';
  } else if (normalized.includes('SELL') || normalized === 'S') {
    return 'SHORT';
  }
  
  return null;
}

function cleanSymbol(symbol) {
  if (!symbol) return '';
  // Remove exchange suffix: "NQH5.CME" -> "NQH5"
  return symbol.split('.')[0].trim();
}

function extractExchange(symbol) {
  if (!symbol) return null;
  const parts = symbol.split('.');
  return parts.length > 1 ? parts[1].trim() : null;
}

export default { parseSierraTradeLog };
