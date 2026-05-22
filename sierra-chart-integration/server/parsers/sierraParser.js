export function parseSierraTradeLog(content) {
  const lines = content.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    throw new Error('Invalid Sierra Chart file: no data rows found');
  }

  const headers = lines[0].split('\t').map(h => h.trim());
  console.log('📋 Sierra Chart columns found:', headers.length, 'columns');

  const trades = [];
  
  for (let i = 1; i < lines.length; i++) {
    try {
      const values = lines[i].split('\t');
      
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index]?.trim() || '';
      });

      // Only process "Fills" activity type
      if (row['ActivityType'] !== 'Fills') {
        continue;
      }

      const trade = mapSierraTradeToSchema(row, i, headers);
      
      if (trade) {
        trades.push(trade);
      }

    } catch (error) {
      console.error(`❌ Error parsing row ${i}:`, error.message);
    }
  }

  return trades;
}

function mapSierraTradeToSchema(sierraRow, rowNumber, headers) {
  try {
    // Sierra Chart columns: DateTime, Symbol, BuySell, Quantity, FillPrice
    const dateTime = parseDateTime(sierraRow['DateTime']);
    const symbol = sierraRow['Symbol'];
    const type = normalizeTradeType(sierraRow['BuySell']);
    const quantity = parseFloat(sierraRow['Quantity']) || 0;
    const price = parseFloat(sierraRow['FillPrice']) || 0;

    if (!dateTime || !symbol || !type) {
      console.warn(`⚠️ Skipping row ${rowNumber}: missing required fields`);
      return null;
    }

    if (quantity === 0 || price === 0) {
      console.warn(`⚠️ Skipping row ${rowNumber}: invalid quantity or price`);
      return null;
    }

    // Calculate P&L if available
    const openClose = sierraRow['OpenClose'];
    let profitLoss = null;
    
    if (openClose === 'Close') {
      const high = parseFloat(sierraRow['HighDuringPosition']) || 0;
      const low = parseFloat(sierraRow['LowDuringPosition']) || 0;
      if (high && low) {
        profitLoss = Math.abs(high - low) * quantity * 20; // NQ point value
      }
    }

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
    // Sierra Chart format: "2025-01-08  09:40:16.024149"
    const cleanDateTime = dateTimeStr.replace(/\s+/g, ' ').trim();
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
