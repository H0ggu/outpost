/** web/vendor/lila/site/src/sound.ts: lila's sound player (reads body[data-sound-set] when imported). */
declare const sound: SoundI & {
  /** Path of a named sound (`move`, `capture`, …) in the current set, or undefined when it can't play. */
  resolvePath(name: string): string | undefined;
};
export default sound;
