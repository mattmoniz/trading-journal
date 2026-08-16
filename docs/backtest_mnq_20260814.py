import struct
import datetime
import os
import re
import json
import csv
from multiprocessing import Pool

def ms_to_dt(ms):
    if ms == 0: return None
    try:
        return datetime.datetime(1899, 12, 30) + datetime.timedelta(microseconds=ms)
    except:
        return None

def backtest_file(filepath):
    filename = os.path.basename(filepath)
    print(f"Backtesting {filename}...")
    
    with open('/home/mmoniz/trading-journal/scratch/levels_1yr.json', 'r') as f:
        levels_data = json.load(f)
        
    CONTRACT_MULTIPLIER = 2  
    STOP_LOSS_PTS = 60       
    MAX_TRADES_PER_DAY = 3
    PROXIMITY_THRESHOLD = 15
    
    trade_log = []
    
    with open(filepath, 'rb') as f:
        header = f.read(56)
        if len(header) < 56:
            return None, []
        header_size = struct.unpack('<I', header[4:8])[0]
        f.seek(header_size)
        
        chunk_size = 40 * 200000 
        record_struct = struct.Struct('<qffffIIII')
        
        current_minute = None
        current_bar = None
        bar_history = []
        
        in_trade = False
        trade_dir = 0
        entry_price = 0.0
        entry_time = None
        matched_level_name = ""
        matched_level_price = 0.0
        CONTRACTS = 1
        scid_multiplier = 1
        
        daily_pnl = {}
        daily_trade_count = {}
        
        target_start_date = datetime.date(2025, 8, 1)
        
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
                
            num_records = len(chunk) // 40
            
            for dt_ms, op, hi, lo, cl, num_trades, tot_vol, bid_vol, ask_vol in record_struct.iter_unpack(chunk[:num_records*40]):
                minute_ms = (dt_ms // 60000000) * 60000000
                delta = ask_vol - bid_vol
                dt = ms_to_dt(minute_ms)
                
                if dt.date() < target_start_date:
                    continue
                    
                date_str = dt.strftime('%Y-%m-%d')
                if date_str not in daily_pnl:
                    daily_pnl[date_str] = 0.0
                    daily_trade_count[date_str] = 0
                    bar_history = []
                    if in_trade:
                        exit_price = cl
                        pts_gained = (exit_price - entry_price) / scid_multiplier if trade_dir == 1 else (entry_price - exit_price) / scid_multiplier
                        profit = pts_gained * CONTRACT_MULTIPLIER * CONTRACTS
                        daily_pnl[date_str] += profit
                        trade_log.append({
                            'Date': date_str,
                            'Entry_Time': entry_time.strftime('%H:%M:%S'),
                            'Exit_Time': dt.strftime('%H:%M:%S'),
                            'Direction': 'LONG' if trade_dir == 1 else 'SHORT',
                            'Level_Name': matched_level_name,
                            'Level_Price': matched_level_price,
                            'Entry_Price': entry_price / scid_multiplier,
                            'Exit_Price': exit_price / scid_multiplier,
                            'Result': 'EOD_CLOSE',
                            'PnL': profit
                        })
                        in_trade = False 
                
                if in_trade:
                    # Hard Stop Loss checking
                    if trade_dir == 1:
                        if lo <= entry_price - (STOP_LOSS_PTS * scid_multiplier):
                            loss = -(STOP_LOSS_PTS * CONTRACT_MULTIPLIER * CONTRACTS)
                            daily_pnl[date_str] += loss
                            trade_log.append({
                                'Date': date_str,
                                'Entry_Time': entry_time.strftime('%H:%M:%S'),
                                'Exit_Time': dt.strftime('%H:%M:%S'),
                                'Direction': 'LONG',
                                'Level_Name': matched_level_name,
                                'Level_Price': matched_level_price,
                                'Entry_Price': entry_price / scid_multiplier,
                                'Exit_Price': (entry_price - (STOP_LOSS_PTS * scid_multiplier)) / scid_multiplier,
                                'Result': 'STOP_LOSS',
                                'PnL': loss
                            })
                            in_trade = False
                    elif trade_dir == -1:
                        if hi >= entry_price + (STOP_LOSS_PTS * scid_multiplier):
                            loss = -(STOP_LOSS_PTS * CONTRACT_MULTIPLIER * CONTRACTS)
                            daily_pnl[date_str] += loss
                            trade_log.append({
                                'Date': date_str,
                                'Entry_Time': entry_time.strftime('%H:%M:%S'),
                                'Exit_Time': dt.strftime('%H:%M:%S'),
                                'Direction': 'SHORT',
                                'Level_Name': matched_level_name,
                                'Level_Price': matched_level_price,
                                'Entry_Price': entry_price / scid_multiplier,
                                'Exit_Price': (entry_price + (STOP_LOSS_PTS * scid_multiplier)) / scid_multiplier,
                                'Result': 'STOP_LOSS',
                                'PnL': loss
                            })
                            in_trade = False
                
                # Bar change logic
                if minute_ms != current_minute:
                    if current_bar is not None:
                        bar_history.append(current_bar)
                        if len(bar_history) > 3:
                            bar_history.pop(0)
                            
                        b_open = current_bar['open']
                        b_close = current_bar['close']
                        b_vol = current_bar['volume']
                        b_delta = current_bar['delta']
                        b_trades = current_bar['trades']
                        
                        price_change = b_close - b_open
                        avg_size = b_vol / b_trades if b_trades > 0 else 0
                        
                        # 2-Bar Trailing Stop Logic (Let winners run)
                        if in_trade and len(bar_history) >= 2:
                            # 2 bars previous is bar_history[-2] since current_bar is bar_history[-1]
                            two_bars_ago = bar_history[-2]
                            
                            if trade_dir == 1:
                                if b_close < two_bars_ago['low']:
                                    exit_price = b_close
                                    pts_gained = (exit_price - entry_price) / scid_multiplier
                                    profit = pts_gained * CONTRACT_MULTIPLIER * CONTRACTS
                                    daily_pnl[date_str] += profit
                                    trade_log.append({
                                        'Date': date_str,
                                        'Entry_Time': entry_time.strftime('%H:%M:%S'),
                                        'Exit_Time': dt.strftime('%H:%M:%S'),
                                        'Direction': 'LONG',
                                        'Level_Name': matched_level_name,
                                        'Level_Price': matched_level_price,
                                        'Entry_Price': entry_price / scid_multiplier,
                                        'Exit_Price': exit_price / scid_multiplier,
                                        'Result': 'STRUCTURAL_TRAILING_EXIT',
                                        'PnL': profit
                                    })
                                    in_trade = False
                            elif trade_dir == -1:
                                if b_close > two_bars_ago['high']:
                                    exit_price = b_close
                                    pts_gained = (entry_price - exit_price) / scid_multiplier
                                    profit = pts_gained * CONTRACT_MULTIPLIER * CONTRACTS
                                    daily_pnl[date_str] += profit
                                    trade_log.append({
                                        'Date': date_str,
                                        'Entry_Time': entry_time.strftime('%H:%M:%S'),
                                        'Exit_Time': dt.strftime('%H:%M:%S'),
                                        'Direction': 'SHORT',
                                        'Level_Name': matched_level_name,
                                        'Level_Price': matched_level_price,
                                        'Entry_Price': entry_price / scid_multiplier,
                                        'Exit_Price': exit_price / scid_multiplier,
                                        'Result': 'STRUCTURAL_TRAILING_EXIT',
                                        'PnL': profit
                                    })
                                    in_trade = False

                        # Entry Signal Logic
                        signal = 0
                        if b_vol > 1500:
                            if price_change > 0 and b_delta < -200:
                                signal = 1
                            elif price_change < 0 and b_delta > 200:
                                signal = -1
                            elif avg_size > 1.2 and b_delta < -150:
                                signal = 1
                            elif avg_size > 1.2 and b_delta > 150:
                                signal = -1
                                
                        if not in_trade and signal != 0 and daily_trade_count[date_str] < MAX_TRADES_PER_DAY:
                            est_dt = dt - datetime.timedelta(hours=4)
                            if est_dt.hour == 9 and 30 <= est_dt.minute < 35:
                                pass # Filter first 5 mins
                            else:
                                valid_level = False
                                if date_str in levels_data:
                                    real_price = b_close / 100.0 if b_close > 100000 else b_close
                                    for lvl in levels_data[date_str]:
                                        if abs(real_price - lvl['price']) <= PROXIMITY_THRESHOLD:
                                            valid_level = True
                                            matched_level_name = lvl['name']
                                            matched_level_price = lvl['price']
                                            break
                                            
                                if valid_level:
                                    in_trade = True
                                    trade_dir = signal
                                    entry_price = b_close
                                    entry_time = dt
                                    scid_multiplier = 100 if b_close > 100000 else 1
                                    daily_trade_count[date_str] += 1
                                
                    current_minute = minute_ms
                    current_bar = {
                        'open': op,
                        'high': hi,
                        'low': lo,
                        'close': cl,
                        'volume': tot_vol,
                        'delta': delta,
                        'trades': num_trades
                    }
                else:
                    if current_bar is not None:
                        current_bar['high'] = max(current_bar['high'], hi)
                        current_bar['low'] = min(current_bar['low'], lo)
                        current_bar['close'] = cl
                        current_bar['volume'] += tot_vol
                        current_bar['delta'] += delta
                        current_bar['trades'] += num_trades
                            
    return daily_pnl, trade_log

if __name__ == '__main__':
    data_dir = '/mnt/c/SierraChart/Data/'
    pattern = re.compile(r'^NQ[HMUZ]\d\.CME\.scid$')
    all_files = os.listdir(data_dir)
    target_files = [os.path.join(data_dir, f) for f in all_files if pattern.match(f)]
    
    with Pool() as pool:
        results = pool.map(backtest_file, target_files)
        
    results = [r for r in results if r[0] is not None]
    
    combined_pnl = {}
    all_trades = []
    for res in results:
        daily_pnl, trades = res
        all_trades.extend(trades)
        for date, pnl in daily_pnl.items():
            combined_pnl[date] = combined_pnl.get(date, 0) + pnl
            
    all_trades.sort(key=lambda x: (x['Date'], x['Entry_Time']))
    
    csv_file = '/home/mmoniz/trading-journal/scratch/mnq_trades_log_trailing.csv'
    if all_trades:
        keys = all_trades[0].keys()
        with open(csv_file, 'w', newline='') as output_file:
            dict_writer = csv.DictWriter(output_file, keys)
            dict_writer.writeheader()
            dict_writer.writerows(all_trades)
            
    sorted_dates = sorted(combined_pnl.keys())
    
    balance = 50000
    peak = 50000
    passed = False
    failed = False
    
    for date in sorted_dates:
        daily_profit = combined_pnl[date]
        if not failed and not passed:
            if daily_profit <= -400:
                failed = True
            else:
                balance += daily_profit
                if balance > peak:
                    peak = balance
                if peak - balance >= 2000:
                    failed = True
                elif balance >= 53000:
                    passed = True
                    
    print(f"Total Trades Logged: {len(all_trades)}")
    print(f"Final Balance: ${balance}")
    print(f"Log saved to: {csv_file}")
