// Official certificate PNG. Positions come from measured glyph bounds so the
// score cannot cover the label, and the photo is a center cover crop.
(function () {
  const W = 1600;
  const PAD = 80;
  const THUMB = 300;
  const GUTTER = 56;
  const SEAL_R = 78;

  const FONT = {
    kicker: '500 15px "JetBrains Mono", monospace',
    score: '900 96px Satoshi, system-ui, sans-serif',
    slash: '500 30px Satoshi, system-ui, sans-serif',
    tier: '500 20px "JetBrains Mono", monospace',
    summary: '500 26px Satoshi, system-ui, sans-serif',
    cat: '500 15px "JetBrains Mono", monospace',
    colTitle: '700 15px Satoshi, system-ui, sans-serif',
    body: '400 24px Satoshi, system-ui, sans-serif',
    flagTitle: '700 15px Satoshi, system-ui, sans-serif',
    flag: '400 22px Satoshi, system-ui, sans-serif',
    bar: '400 20px Satoshi, system-ui, sans-serif',
    barScore: '500 18px "JetBrains Mono", monospace',
    meta: '400 16px "JetBrains Mono", monospace',
    footer: '500 15px "JetBrains Mono", monospace',
    seal: '900 26px Satoshi, system-ui, sans-serif',
  };

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';

    function push(value) {
      if (value) lines.push(value);
    }

    for (const word of words) {
      if (ctx.measureText(word).width > maxWidth) {
        push(line);
        line = '';
        let chunk = '';
        for (const ch of word) {
          const next = chunk + ch;
          if (ctx.measureText(next).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk = next;
          }
        }
        line = chunk;
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    push(line);
    return lines.length ? lines : [''];
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read the graded image'));
      img.src = src;
    });
  }

  function box(ctx, font, text) {
    ctx.font = font;
    const sample = text && String(text).trim() ? String(text) : 'Mg';
    const m = ctx.measureText(sample);
    const ascent = m.actualBoundingBoxAscent || 0;
    const descent = m.actualBoundingBoxDescent || 0;
    const width = text ? ctx.measureText(String(text)).width : 0;
    return { width, ascent, descent, height: Math.max(1, ascent + descent) };
  }

  function ellipsize(ctx, font, text, maxWidth) {
    ctx.font = font;
    const value = String(text || '');
    if (ctx.measureText(value).width <= maxWidth) return value;
    let s = value;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  }

  async function ensureFonts() {
    await document.fonts.ready;
    await Promise.all(Object.values(FONT).map((font) => document.fonts.load(font)));
  }

  function layout(ctx, grade, kicker) {
    const pass = grade.verdict === 'PASS';
    const accent = pass ? '#34d399' : '#f87171';
    const textX = PAD + THUMB + 48;
    const textW = W - PAD - SEAL_R * 2 - 72 - textX;
    const colW = (W - PAD * 2 - GUTTER) / 2;
    const ops = [];
    const text = (font, value, x, top, color, align) => {
      const b = box(ctx, font, value);
      ops.push({
        type: 'text',
        font,
        text: value,
        x,
        baseline: top + b.ascent,
        color,
        align: align || 'left',
      });
      return { width: b.width, bottom: top + b.height, ascent: b.ascent, height: b.height };
    };

    let top = PAD;
    const kickerBox = text(FONT.kicker, kicker, textX, top, 'rgba(255,255,255,0.45)');
    top = kickerBox.bottom + 22;

    const scoreText = Number(grade.score).toFixed(1);
    const scoreBox = text(FONT.score, scoreText, textX, top, '#ffffff');
    const slash = box(ctx, FONT.slash, '/10');
    ops.push({
      type: 'text',
      font: FONT.slash,
      text: '/10',
      x: textX + scoreBox.width + 12,
      baseline: top + scoreBox.ascent - 4,
      color: 'rgba(255,255,255,0.42)',
      align: 'left',
    });
    top = scoreBox.bottom + 18;

    const tierBox = text(FONT.tier, String(grade.tier || '').toUpperCase(), textX, top, accent);
    top = tierBox.bottom + 18;

    ctx.font = FONT.summary;
    const summaryLines = wrapLines(ctx, grade.summary, textW);
    for (const line of summaryLines) {
      const lineBox = text(FONT.summary, line, textX, top, 'rgba(255,255,255,0.68)');
      top = lineBox.bottom + 8;
    }
    top += 12;

    const category = String(grade.category || '');
    const cat = box(ctx, FONT.cat, category);
    const pillH = cat.height + 16;
    const pillW = cat.width + 28;
    ops.push({ type: 'pill', x: textX, y: top, w: pillW, h: pillH });
    ops.push({
      type: 'text',
      font: FONT.cat,
      text: category,
      x: textX + 14,
      baseline: top + 8 + cat.ascent,
      color: 'rgba(255,255,255,0.5)',
      align: 'left',
    });
    top += pillH;

    const headerBottom = Math.max(PAD + THUMB, top);
    const thumb = { x: PAD, y: PAD, size: THUMB };
    const seal = {
      cx: W - PAD - SEAL_R,
      cy: PAD + (headerBottom - PAD) / 2,
      verdict: grade.verdict,
      color: accent,
    };

    top = headerBottom + 48;
    ctx.font = FONT.body;
    const strengths = (grade.strengths?.length ? grade.strengths : ['None noted.']).map((item) => wrapLines(ctx, item, colW - 8));
    const weaknesses = (grade.weaknesses?.length ? grade.weaknesses : ['None noted.']).map((item) => wrapLines(ctx, item, colW - 8));

    function column(title, groups, x, start) {
      let y = start;
      const titleBox = text(FONT.colTitle, title, x, y, 'rgba(255,255,255,0.42)');
      y = titleBox.bottom + 16;
      for (const lines of groups) {
        ops.push({ type: 'rule', x, y, w: colW, color: 'rgba(255,255,255,0.12)' });
        y += 14;
        for (const line of lines) {
          const lineBox = text(FONT.body, line, x, y, 'rgba(255,255,255,0.9)');
          y = lineBox.bottom + 6;
        }
        y += 14;
      }
      return y;
    }

    const leftBottom = column('WHY IT WORKS', strengths, PAD, top);
    const rightBottom = column('WHAT HOLDS IT BACK', weaknesses, PAD + colW + GUTTER, top);
    top = Math.max(leftBottom, rightBottom) + 8;

    const flags = grade.redFlags || [];
    if (flags.length) {
      top += 20;
      ctx.font = FONT.flag;
      const flagLines = flags.map((item) => wrapLines(ctx, item, W - PAD * 2));
      const titleBox = text(FONT.flagTitle, 'RED FLAGS', PAD, top, 'rgba(255,255,255,0.42)');
      top = titleBox.bottom + 16;
      for (const lines of flagLines) {
        ops.push({ type: 'rule', x: PAD, y: top, w: W - PAD * 2, color: 'rgba(248,113,113,0.35)' });
        top += 14;
        for (const line of lines) {
          const lineBox = text(FONT.flag, line, PAD, top, '#fecaca');
          top = lineBox.bottom + 6;
        }
        top += 12;
      }
    }

    const bars = grade.elementScores || [];
    if (bars.length) {
      top += 18;
      const scoreCol = 64;
      ctx.font = FONT.bar;
      const labels = bars.map((el) => ellipsize(ctx, FONT.bar, el.name, 240));
      const labelW = Math.min(240, Math.max(120, ...labels.map((label) => box(ctx, FONT.bar, label).width)) + 20);
      const trackX = PAD + labelW;
      const trackW = W - PAD - scoreCol - trackX;
      for (let i = 0; i < bars.length; i++) {
        const b = box(ctx, FONT.bar, labels[i]);
        const rowH = Math.max(28, b.height);
        const rowTop = top + (rowH - b.height) / 2;
        text(FONT.bar, labels[i], PAD, rowTop, 'rgba(255,255,255,0.62)');
        const scoreLabel = Number(bars[i].score).toFixed(1);
        const scoreMetrics = box(ctx, FONT.barScore, scoreLabel);
        text(FONT.barScore, scoreLabel, W - PAD, rowTop + (rowH - scoreMetrics.height) / 2, 'rgba(255,255,255,0.72)', 'right');
        const trackY = top + rowH / 2 - 4;
        ops.push({
          type: 'bar',
          x: trackX,
          y: trackY,
          w: trackW,
          h: 8,
          amount: Math.max(0, Math.min(1, Number(bars[i].score) / 10)),
        });
        top += rowH + 12;
      }
    }

    if (grade.bindingCap != null || (grade.capsApplied || []).length) {
      const bits = [];
      if (grade.bindingCap != null) bits.push(`Score ceiling ${Number(grade.bindingCap).toFixed(1)}`);
      if ((grade.capsApplied || []).length) bits.push(`Caps applied: ${grade.capsApplied.join(' · ')}`);
      top += 8;
      ctx.font = FONT.meta;
      const metaLines = wrapLines(ctx, bits.join('   ·   '), W - PAD * 2);
      for (const line of metaLines) {
        const lineBox = text(FONT.meta, line, PAD, top, 'rgba(255,255,255,0.4)');
        top = lineBox.bottom + 6;
      }
    }

    top += 36;
    const footer = text(FONT.footer, 'THE MONEY MACHINE', PAD, top, 'rgba(255,255,255,0.32)');
    const H = Math.ceil(footer.bottom + 72);

    return { W, H, ops, thumb, seal, accent };
  }

  function paint(ctx, img, plan) {
    const { W, H, ops, thumb, seal } = plan;
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(28, 28, W - 56, H - 56);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(40, 40, W - 80, H - 80);

    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(thumb.x, thumb.y, thumb.size, thumb.size);
    ctx.clip();
    ctx.drawImage(img, sx, sy, side, side, thumb.x, thumb.y, thumb.size, thumb.size);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(thumb.x + 1, thumb.y + 1, thumb.size - 2, thumb.size - 2);

    for (const op of ops) {
      if (op.type === 'text') {
        ctx.font = op.font;
        ctx.fillStyle = op.color;
        ctx.textAlign = op.align;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(op.text, op.x, op.baseline);
      } else if (op.type === 'pill') {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      } else if (op.type === 'rule') {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(op.x, op.y);
        ctx.lineTo(op.x + op.w, op.y);
        ctx.stroke();
      } else if (op.type === 'bar') {
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath();
        ctx.roundRect(op.x, op.y, op.w, op.h, 99);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.beginPath();
        ctx.roundRect(op.x, op.y, Math.max(op.h, op.w * op.amount), op.h, 99);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.translate(seal.cx, seal.cy);
    ctx.rotate(-12 * Math.PI / 180);
    ctx.strokeStyle = seal.color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, SEAL_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, SEAL_R - 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = seal.color;
    ctx.font = FONT.seal;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(seal.verdict, 0, 1);
    ctx.restore();
  }

  async function renderCertificate(grade, imageUrl, options) {
    await ensureFonts();
    const img = await loadImage(imageUrl);
    const measure = document.createElement('canvas').getContext('2d');
    const plan = layout(measure, grade, (options && options.kicker) || 'CLOG CERTIFICATE');
    const canvas = document.createElement('canvas');
    canvas.width = plan.W;
    canvas.height = plan.H;
    paint(canvas.getContext('2d'), img, plan);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not build the certificate image');
    return blob;
  }

  window.renderCertificate = renderCertificate;
})();
