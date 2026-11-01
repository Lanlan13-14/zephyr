import test from 'node:test';
import assert from 'node:assert/strict';
import { Motion } from '../public/vendor/zephyr-motion/motion.js';
import { MOTION_STANDARDS } from '../public/vendor/zephyr-motion/presets.js';
function el() { return { style: { setProperty(){}, removeProperty(){} } }; }
test('timeScale stretches the flip timeline without changing its normalized curve', async () => {
  await Motion.init({capacity:256}); Motion.setReducedMotion(false);
  const normal=el(), slow=el();
  Motion.set(normal,{rotateY:0});Motion.set(slow,{rotateY:0});
  const p1=Motion.to(normal,{rotateY:180},{standard:MOTION_STANDARDS.iosCardFlipOpen});
  const p2=Motion.to(slow,{rotateY:180},{standard:MOTION_STANDARDS.iosCardFlipOpen,timeScale:1.5});
  for(let i=0;i<12;i++)Motion.engine.tick(1/120);
  const at100=Motion.value(normal,'rotateY');
  for(let i=0;i<6;i++)Motion.engine.tick(1/120);
  const slow150=Motion.value(slow,'rotateY');
  assert.ok(at100>1 && at100<179);
  assert.ok(Math.abs(at100-slow150)<1.5,`same curve: normal100=${at100}, slow150=${slow150}`);
  assert.ok(Motion.value(normal,'rotateY')>slow150,'scaled motion is slower at same wall time');
  for(let i=0;i<600;i++)Motion.engine.tick(1/120);
  await Promise.all([p1,p2]);
  assert.equal(Motion.value(normal,'rotateY'),180);assert.equal(Motion.value(slow,'rotateY'),180);
  Motion.release(normal);Motion.release(slow);
});
