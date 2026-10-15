// Make an image, then animate it. Needs SUME_API_KEY. Costs about $0.06.
import { run } from "@sume-com/open";

const image = await run("gpt-image-2", "a ceramic cup on a wooden table, morning light", { quality: "low" });
console.log("image", await image.save("cup.png"), `$${image.usd}`);

const video = await run("grok-imagine-video-1.5", "slow push in, steam rising", {
  image: "cup.png",
  duration: 4,
  resolution: "480p",
});
console.log("video", await video.save("cup.mp4"), `$${video.usd}`);
