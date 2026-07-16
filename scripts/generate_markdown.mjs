import fs from 'fs';

const raw = fs.readFileSync('scratch/verification_findings.json', 'utf8');
const data = JSON.parse(raw);

let md = `# AUTONOMOUS EXECUTION COMPLETED
## Check 1: Rigor-verify the confluence tier finding (15pt base)
`;

for (const stop of [60, 90, 120]) {
  md += `\n### Stop = ${stop}pt (15pt proximity)\n`;
  for (const tier of ['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD_PLUS']) {
    const res = data.confluence['15'][tier][stop];
    if (res) {
      const { rigor } = res;
      md += `- **${tier}**: N=${res.n}, EV=$${res.ev.toFixed(2)}, WR=${(res.wr*100).toFixed(1)}%\n`;
      if (rigor && rigor.thirds) {
        md += `  Rigor: distinctDates=${rigor.distinctDates}, top5DayPct=${rigor.top5DayPct}%, clustered=${rigor.clustered}, stable=${rigor.stable}, clean=${rigor.clean}\n`;
        md += `  Thirds: EV1=$${rigor.thirds.ev1?.toFixed(2)}, EV2=$${rigor.thirds.ev2?.toFixed(2)}, EV3=$${rigor.thirds.ev3?.toFixed(2)}\n`;
      }
    }
  }
}

md += `\n## Check 2: Day-type-controlled re-test of the rotation-sizing signal (15pt base)\n`;
const c15 = data.rotation['15'];
for (const cand of c15) {
  md += `\n### ${cand.setupType} | prior: ${cand.priorKey}\n`;
  md += `- Overall Base N=${cand.baseN}, EV=$${cand.baseEV.toFixed(2)} | Cond N=${cand.condN}, EV=$${cand.condEV.toFixed(2)}\n`;
  for (const [dt, stats] of Object.entries(cand.byDayType)) {
    const isDirBase = stats.baseN < 20 ? ' (directional-only)' : '';
    const isDirCond = stats.condN < 20 ? ' (directional-only)' : '';
    md += `  - **${dt}**: Base N=${stats.baseN}${isDirBase} EV=$${stats.baseEV.toFixed(2)} | Cond N=${stats.condN}${isDirCond} EV=$${stats.condEV.toFixed(2)} (Lift: $${stats.lift.toFixed(2)})\n`;
  }
}

md += `\n## Check 3: Parameter sensitivity (10pt and 20pt thresholds)\n`;

md += `\n### Confluence Sensitivity (Stop=90pt)\n`;
for (const prox of ['10', '20']) {
  md += `\n**Proximity = ${prox}pt**:\n`;
  for (const tier of ['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD_PLUS']) {
    const res = data.confluence[prox][tier]['90'];
    if (res) {
      md += `- ${tier}: N=${res.n}, EV=$${res.ev.toFixed(2)}, WR=${(res.wr*100).toFixed(1)}%\n`;
    }
  }
}

md += `\n### Rotation Sizing Sensitivity\n`;
for (const prox of ['10', '20']) {
  md += `\n**Proximity = ${prox}pt** (Summary of conditional EV lift by DayType):\n`;
  const rotData = data.rotation[prox];
  for (let i=0; i<3; i++) {
    const cand = rotData[i];
    if(!cand) continue;
    md += `- ${cand.setupType} / ${cand.priorKey}: Cond N=${cand.condN}, Cond EV=$${cand.condEV.toFixed(2)}\n`;
  }
  md += `- ... (see full data for rest)\n`;
}

fs.writeFileSync('scratch/antigravity_response.md', md);
console.log('Markdown generated.');
