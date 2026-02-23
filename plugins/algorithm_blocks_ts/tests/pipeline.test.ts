import assert from "node:assert/strict";
import test from "node:test";

import { MovingAverageBlock } from "../src/blocks/moving_average.js";
import { PidBlock } from "../src/blocks/pid.js";
import { SummarizerBlock } from "../src/blocks/summarizer.js";
import { AlgorithmPipeline } from "../src/pipeline.js";

test("pipeline chains moving average + summarizer and keeps history/stats", () => {
  const pipeline = new AlgorithmPipeline({
    historySize: 16,
    statsWindow: 8,
    statsFields: ["velocity"],
  });

  const ma = new MovingAverageBlock("ma");
  ma.init({
    sourceKey: "velocity",
    outputKey: "moving_average.velocity",
    window: 4,
  });

  const summary = new SummarizerBlock("summary");
  summary.init({
    keys: ["velocity"],
    window: 4,
    outputKey: "summary",
  });

  pipeline.addBlock(ma);
  pipeline.addBlock(summary);

  let latest = pipeline.process({ timestamp: 1, parsed: { velocity: 1 } });
  latest = pipeline.process({ timestamp: 2, parsed: { velocity: 2 } });
  latest = pipeline.process({ timestamp: 3, parsed: { velocity: 3 } });
  latest = pipeline.process({ timestamp: 4, parsed: { velocity: 4 } });

  assert.equal(latest.features?.["moving_average.velocity"], 2.5);
  assert.deepEqual(latest.features?.summary?.velocity, {
    mean: 2.5,
    delta: 3,
    abs_delta: 3,
    min: 1,
    max: 4,
  });

  const lastTwo = pipeline.getLastN(2);
  assert.equal(lastTwo.length, 2);
  assert.equal(lastTwo[0].timestamp, 3);
  assert.equal(lastTwo[1].timestamp, 4);

  const stats = pipeline.getStats();
  assert.equal(stats.fields.velocity.count, 4);
  assert.equal(stats.fields.velocity.mean, 2.5);
  assert.equal(stats.fields.velocity.delta, 3);
});

test("pid block outputs control suggestion field", () => {
  const pipeline = new AlgorithmPipeline();
  const pid = new PidBlock("pid");
  pid.init({
    measurementKey: "velocity",
    setpoint: 10,
    kp: 2,
    ki: 0,
    kd: 0,
    dtSeconds: 0.1,
    outputKey: "control.target_pwm",
  });
  pipeline.addBlock(pid);

  const input = { timestamp: 1, parsed: { velocity: 8 } };
  const processed = pipeline.process(input);

  assert.notEqual(processed, input);
  assert.equal(processed.features?.["control.target_pwm"], 4);
  assert.equal(processed.features?.["pid.error"], 2);
  assert.equal(processed.features?.["pid.output"], 4);
});
