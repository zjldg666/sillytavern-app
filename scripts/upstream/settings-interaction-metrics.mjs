// 只记录交互耗时和帧间隔，不读取表单内容或用户提示词。
export async function measureInteraction(page, action, target) {
    return page.evaluate(async ({ action, target }) => {
        const button = document.querySelector(action), panel = document.querySelector(target);
        if (!button || !panel) throw new Error('缺少待测控件');
        const tasks = [];
        const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
        observer.observe({ type: 'longtask' });
        const start = performance.now();
        button.click();
        const handlerMs = performance.now() - start;
        let previous, stable = 0, lastFrame = start, maxFrameGap = 0;
        const motions = new Set();
        await new Promise((resolve, reject) => {
            function frame(now) {
                maxFrameGap = Math.max(maxFrameGap, now - lastFrame); lastFrame = now;
                const rect = panel.getBoundingClientRect();
                const geometry = [rect.x, rect.y, rect.width, rect.height, getComputedStyle(panel).display].join(',');
                const animating = window.jQuery.timers.some(timer => timer.elem === panel || panel.contains(timer.elem)) || panel.getAnimations({ subtree: false }).some(a => a.playState === 'running');
                for (const timer of window.jQuery.timers.filter(t => t.elem === panel || panel.contains(t.elem))) motions.add(`jquery:${timer.anim.duration}`);
                for (const a of panel.getAnimations()) motions.add(`css:${a.transitionProperty || a.animationName}:${a.effect.getTiming().duration}`);
                stable = !animating && geometry === previous ? stable + 1 : 0;
                previous = geometry;
                if (stable >= 2) resolve();
                else if (now - start > 5000) reject(new Error('交互五秒后仍未稳定'));
                else requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        });
        observer.disconnect();
        return { handlerMs: Math.round(handlerMs), settledMs: Math.round(performance.now() - start), maxFrameGap: Math.round(maxFrameGap), longTasks: tasks.map(Math.round), motions: [...motions] };
    }, { action, target });
}
