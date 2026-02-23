import { AlgorithmPipeline } from "./pipeline.js";
import { MovingAverageBlock } from "./blocks/moving_average.js";
import { SummarizerBlock } from "./blocks/summarizer.js";

const pipeline = new AlgorithmPipeline({
  historySize: 64,
  statsWindow: 32,
  statsFields: ["velocity"],
});

const ma = new MovingAverageBlock("ma");
ma.init({
  sourceKey: "velocity",
  outputKey: "moving_average.velocity",
  window: 8,
});

const summarizer = new SummarizerBlock("summary");
summarizer.init({
  keys: ["velocity"],
  window: 16,
  outputKey: "summary",
});

pipeline.addBlock(ma);
pipeline.addBlock(summarizer);

for (let i = 0; i < 20; i += 1) {
  const velocity = 1.5 + Math.sin(i * 0.35);
  const processed = pipeline.process({
    timestamp: Date.now(),
    parsed: { velocity },
  });
  const summary = processed.features?.summary;
  console.log(
    JSON.stringify(
      {
        i,
        velocity,
        movingAverage: processed.features?.["moving_average.velocity"],
        summary,
      },
      null,
      2,
    ),
  );
}

console.log("pipeline_stats", JSON.stringify(pipeline.getStats(), null, 2));
