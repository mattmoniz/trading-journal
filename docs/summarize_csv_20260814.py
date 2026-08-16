import csv
import datetime
from collections import defaultdict

def analyze_trades():
    csv_file = '/home/mmoniz/trading-journal/scratch/mnq_trades_log_trailing.csv'
    trades = []
    
    with open(csv_file, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            row['PnL'] = float(row['PnL'])
            trades.append(row)
            
    # Losing Days Analysis
    daily_pnl = defaultdict(float)
    for t in trades:
        daily_pnl[t['Date']] += t['PnL']
        
    losing_days = []
    for date, pnl in daily_pnl.items():
        if pnl < 0:
            losing_days.append((date, pnl))
            
    losing_days.sort(key=lambda x: x[0])
    
    max_consecutive_losing_days = 0
    current_streak = 0
    prev_date = None
    
    for date, pnl in losing_days:
        dt = datetime.datetime.strptime(date, '%Y-%m-%d')
        if prev_date is None:
            current_streak = 1
        else:
            if (dt - prev_date).days == 1 or (dt.weekday() == 0 and prev_date.weekday() == 4 and (dt - prev_date).days == 3):
                current_streak += 1
            else:
                current_streak = 1
        
        if current_streak > max_consecutive_losing_days:
            max_consecutive_losing_days = current_streak
        prev_date = dt
        
    print("=== LOSING DAYS SUMMARY ===")
    print(f"Total Losing Days: {len(losing_days)}")
    print(f"Max Consecutive Losing Days: {max_consecutive_losing_days}")
    loss_amounts = [x[1] for x in losing_days]
    print(f"Average Loss on a Losing Day: ${sum(loss_amounts)/len(loss_amounts):.2f}")
    print(f"Worst Losing Day: ${min(loss_amounts):.2f}")
    
    # Weekly breakdown
    weekly_pnl = defaultdict(float)
    for date, pnl in daily_pnl.items():
        dt = datetime.datetime.strptime(date, '%Y-%m-%d')
        # Get ISO week number
        year, week, _ = dt.isocalendar()
        weekly_pnl[f"{year}-W{week:02d}"] += pnl
        
    print("\n=== WEEKLY PnL BREAKDOWN (Sample) ===")
    weeks = sorted(weekly_pnl.keys())
    for w in weeks[:10]:
        print(f"{w}: ${weekly_pnl[w]:.2f}")
    print("...")
    for w in weeks[-5:]:
        print(f"{w}: ${weekly_pnl[w]:.2f}")
        
    # Sample Trades
    print("\n=== TRADE SAMPLES (First 3 Trades) ===")
    for t in trades[:3]:
        print(f"Date: {t['Date']} | {t['Entry_Time']} -> {t['Exit_Time']}")
        print(f"Dir: {t['Direction']} | Level: {t['Level_Name']} (@ {float(t['Level_Price']):.2f})")
        print(f"Entry: {float(t['Entry_Price']):.2f} | Exit: {float(t['Exit_Price']):.2f} | Result: {t['Result']} (${t['PnL']:.2f})\n")

if __name__ == '__main__':
    analyze_trades()
