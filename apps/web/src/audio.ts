const MUTE_STORAGE_KEY = "swarms.audioMuted";
const MAX_ACTIVE_VOICES = 28;
const ESSENCE_COMBO_WINDOW_MS = 1600;
const ESSENCE_MAX_COMBO = 16;

// D Dorian / dark-luminous pentatonic-hexatonic ladder in semitones above D5 (587.33 Hz)
const ESSENCE_SEMITONE_LADDER: readonly number[] = [
  0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24, 26, 27,
];

export type WeaponSoundId =
  | "bolt"
  | "scatter"
  | "hellscatter"
  | "lance"
  | "phantom"
  | "scythe"
  | "wisp"
  | "storm"
  | "orbit"
  | (string & {});

export type SpellSoundId = "nova" | "volley" | "shell" | "frost" | "chain" | (string & {});

export type ContractSoundKind = "posted" | "accepted" | "settled" | "alert";

export interface HitSoundOpts {
  kill?: boolean | undefined;
  elite?: boolean | undefined;
  boss?: boolean | undefined;
  blocked?: boolean | undefined;
}

interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  endFreq?: number;
  midFreq?: number;
  midRatio?: number;
  duration: number;
  gain: number;
  attack?: number;
  delay?: number;
  detune?: number;
  filterType?: BiquadFilterType;
  filterFreq?: number;
  filterEndFreq?: number;
  filterQ?: number;
  pan?: number;
}

interface NoiseSpec {
  duration: number;
  gain: number;
  attack?: number;
  delay?: number;
  playbackRate?: number;
  filterType?: BiquadFilterType;
  filterFreq: number;
  filterEndFreq?: number;
  filterQ?: number;
  pan?: number;
}

type AudioContextConstructor = typeof AudioContext;

function resolveAudioContextCtor(): AudioContextConstructor | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function readPersistedMute(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

function writePersistedMute(muted: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Ignore storage quota or privacy-mode errors
  }
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted: boolean = readPersistedMute();
  private activeVoices = 0;
  private readonly lastPlayedAt = new Map<string, number>();
  private lastEssenceAt = -Infinity;
  private essenceCombo = 0;

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): boolean {
    this.muted = Boolean(muted);
    writePersistedMute(this.muted);
    if (this.masterGain && this.ctx) {
      const t = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.78, t, 0.015);
    }
    return this.muted;
  }

  public toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  public unlock(): void {
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return;

    try {
      if (!this.ctx) {
        const ctx = new Ctor();
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-16, ctx.currentTime);
        compressor.knee.setValueAtTime(18, ctx.currentTime);
        compressor.ratio.setValueAtTime(6, ctx.currentTime);
        compressor.attack.setValueAtTime(0.003, ctx.currentTime);
        compressor.release.setValueAtTime(0.14, ctx.currentTime);

        const master = ctx.createGain();
        master.gain.setValueAtTime(this.muted ? 0 : 0.78, ctx.currentTime);

        compressor.connect(master);
        master.connect(ctx.destination);

        this.ctx = ctx;
        this.compressor = compressor;
        this.masterGain = master;
        this.noiseBuffer = this.buildNoiseBuffer(ctx);
      }

      if (this.ctx.state === "suspended") {
        void this.ctx.resume().catch(() => {});
      }
    } catch {
      // Safely degrade to no-op if WebAudio initialization fails
      this.ctx = null;
      this.compressor = null;
      this.masterGain = null;
    }
  }

  public playShoot(weapon: WeaponSoundId): void {
    if (!this.canPlay("shoot", 45)) return;
    const jitter = (Math.random() - 0.5) * 28;

    switch (weapon) {
      case "bolt": {
        this.tone({
          type: "triangle",
          freq: 780,
          endFreq: 210,
          duration: 0.095,
          gain: 0.19,
          attack: 0.003,
          detune: jitter,
        });
        this.tone({
          type: "sine",
          freq: 1180,
          endFreq: 540,
          duration: 0.075,
          gain: 0.09,
          attack: 0.002,
          detune: -jitter,
        });
        this.noise({
          duration: 0.036,
          gain: 0.09,
          filterType: "bandpass",
          filterFreq: 1950,
          filterEndFreq: 920,
          filterQ: 2.4,
        });
        break;
      }
      case "scatter": {
        this.tone({
          type: "sawtooth",
          freq: 195,
          endFreq: 58,
          duration: 0.115,
          gain: 0.22,
          attack: 0.002,
          detune: jitter,
          filterType: "lowpass",
          filterFreq: 1100,
          filterEndFreq: 260,
        });
        this.noise({
          duration: 0.095,
          gain: 0.21,
          attack: 0.002,
          filterType: "bandpass",
          filterFreq: 1450,
          filterEndFreq: 420,
          filterQ: 1.3,
        });
        break;
      }
      case "hellscatter": {
        this.tone({
          type: "sawtooth",
          freq: 148,
          endFreq: 40,
          duration: 0.165,
          gain: 0.26,
          attack: 0.003,
          detune: jitter,
          filterType: "lowpass",
          filterFreq: 920,
          filterEndFreq: 180,
        });
        this.tone({
          type: "sawtooth",
          freq: 218,
          endFreq: 68,
          duration: 0.14,
          gain: 0.14,
          attack: 0.004,
          detune: jitter + 18,
        });
        this.noise({
          duration: 0.15,
          gain: 0.22,
          attack: 0.003,
          filterType: "bandpass",
          filterFreq: 980,
          filterEndFreq: 240,
          filterQ: 1.1,
        });
        break;
      }
      case "lance": {
        this.tone({
          type: "sawtooth",
          freq: 1640,
          endFreq: 290,
          duration: 0.12,
          gain: 0.18,
          attack: 0.002,
          detune: jitter,
          filterType: "bandpass",
          filterFreq: 2200,
          filterEndFreq: 680,
          filterQ: 2.2,
        });
        this.tone({
          type: "sine",
          freq: 920,
          endFreq: 460,
          duration: 0.11,
          gain: 0.11,
          attack: 0.003,
        });
        this.noise({
          duration: 0.085,
          gain: 0.11,
          filterType: "highpass",
          filterFreq: 2400,
          filterEndFreq: 900,
          filterQ: 1.8,
        });
        break;
      }
      case "phantom": {
        this.tone({
          type: "sine",
          freq: 590,
          midFreq: 960,
          midRatio: 0.38,
          endFreq: 470,
          duration: 0.145,
          gain: 0.15,
          attack: 0.008,
          detune: jitter - 14,
        });
        this.tone({
          type: "triangle",
          freq: 885,
          midFreq: 1320,
          midRatio: 0.35,
          endFreq: 640,
          duration: 0.135,
          gain: 0.09,
          attack: 0.01,
          detune: jitter + 16,
        });
        this.noise({
          duration: 0.11,
          gain: 0.07,
          attack: 0.01,
          filterType: "bandpass",
          filterFreq: 2150,
          filterEndFreq: 1200,
          filterQ: 5.5,
        });
        break;
      }
      case "scythe": {
        this.noise({
          duration: 0.175,
          gain: 0.19,
          attack: 0.018,
          filterType: "bandpass",
          filterFreq: 380,
          filterEndFreq: 1320,
          filterQ: 2.8,
        });
        this.tone({
          type: "triangle",
          freq: 520,
          endFreq: 240,
          duration: 0.15,
          gain: 0.14,
          attack: 0.012,
          detune: jitter,
        });
        this.tone({
          type: "sine",
          freq: 1040,
          endFreq: 690,
          duration: 0.09,
          gain: 0.07,
          delay: 0.02,
          attack: 0.005,
        });
        break;
      }
      case "wisp": {
        this.tone({
          type: "sine",
          freq: 1160,
          endFreq: 1780,
          duration: 0.088,
          gain: 0.13,
          attack: 0.004,
          detune: jitter,
        });
        this.tone({
          type: "triangle",
          freq: 2320,
          endFreq: 2960,
          duration: 0.068,
          gain: 0.06,
          delay: 0.01,
          attack: 0.003,
          detune: -jitter,
        });
        break;
      }
      case "storm": {
        this.tone({
          type: "sawtooth",
          freq: 1980,
          endFreq: 175,
          duration: 0.088,
          gain: 0.17,
          attack: 0.001,
          detune: jitter,
          filterType: "bandpass",
          filterFreq: 2600,
          filterEndFreq: 520,
          filterQ: 1.9,
        });
        this.noise({
          duration: 0.072,
          gain: 0.15,
          attack: 0.001,
          filterType: "highpass",
          filterFreq: 2700,
          filterEndFreq: 1100,
          filterQ: 2.2,
        });
        this.tone({
          type: "triangle",
          freq: 118,
          endFreq: 48,
          duration: 0.11,
          gain: 0.13,
          attack: 0.003,
        });
        break;
      }
      case "orbit": {
        this.tone({
          type: "triangle",
          freq: 330,
          midFreq: 392,
          midRatio: 0.45,
          endFreq: 310,
          duration: 0.115,
          gain: 0.13,
          attack: 0.01,
          detune: jitter - 8,
        });
        this.tone({
          type: "sine",
          freq: 495,
          midFreq: 587,
          midRatio: 0.45,
          endFreq: 465,
          duration: 0.115,
          gain: 0.09,
          attack: 0.01,
          detune: jitter + 8,
        });
        break;
      }
      default: {
        this.tone({
          type: "triangle",
          freq: 640,
          endFreq: 220,
          duration: 0.085,
          gain: 0.16,
          attack: 0.003,
          detune: jitter,
        });
        break;
      }
    }
  }

  public playHit(opts?: HitSoundOpts): void {
    const blocked = Boolean(opts?.blocked);
    const kill = Boolean(opts?.kill);
    const elite = Boolean(opts?.elite);
    const boss = Boolean(opts?.boss);
    const jitter = (Math.random() - 0.5) * 36;

    if (blocked) {
      if (!this.canPlay("hit:blocked", 40)) return;
      this.tone({
        type: "triangle",
        freq: 2180,
        endFreq: 1720,
        duration: 0.11,
        gain: 0.16,
        attack: 0.001,
        detune: jitter,
      });
      this.tone({
        type: "sine",
        freq: 3460,
        endFreq: 2890,
        duration: 0.085,
        gain: 0.1,
        attack: 0.001,
        detune: -jitter,
      });
      this.noise({
        duration: 0.032,
        gain: 0.11,
        filterType: "bandpass",
        filterFreq: 3800,
        filterQ: 4.5,
      });
      return;
    }

    if (kill) {
      if (!this.canPlay("kill", 45)) return;
      // Bone-shatter impact + secondary fracture snap
      this.tone({
        type: "triangle",
        freq: 158,
        endFreq: 44,
        duration: 0.11,
        gain: 0.24,
        attack: 0.002,
        detune: jitter,
      });
      this.noise({
        duration: 0.078,
        gain: 0.22,
        attack: 0.001,
        filterType: "bandpass",
        filterFreq: 2250,
        filterEndFreq: 680,
        filterQ: 2.6,
      });
      this.noise({
        duration: 0.048,
        gain: 0.14,
        delay: 0.028,
        attack: 0.001,
        filterType: "bandpass",
        filterFreq: 1720,
        filterEndFreq: 920,
        filterQ: 3.4,
      });
      this.tone({
        type: "sine",
        freq: 520,
        endFreq: 260,
        duration: 0.07,
        gain: 0.1,
        delay: 0.012,
        detune: jitter,
      });
    } else {
      if (!this.canPlay("hit", 32)) return;
      // Flesh & bone impact thud
      this.tone({
        type: "triangle",
        freq: 172,
        endFreq: 54,
        duration: 0.068,
        gain: 0.18,
        attack: 0.002,
        detune: jitter,
      });
      this.noise({
        duration: 0.044,
        gain: 0.14,
        attack: 0.001,
        filterType: "bandpass",
        filterFreq: 1180,
        filterEndFreq: 420,
        filterQ: 1.9,
      });
    }

    if ((elite || boss) && this.canPlay("hit:heavy", 65)) {
      const subDur = boss ? 0.3 : 0.21;
      const bellBase = boss ? 293.66 : 440;
      this.tone({
        type: "sine",
        freq: boss ? 98 : 112,
        endFreq: 32,
        duration: subDur,
        gain: boss ? 0.28 : 0.22,
        attack: 0.003,
      });
      this.tone({
        type: "triangle",
        freq: bellBase,
        endFreq: bellBase * 0.985,
        duration: subDur,
        gain: boss ? 0.16 : 0.12,
        attack: 0.002,
        detune: jitter * 0.5,
      });
      this.tone({
        type: "sine",
        freq: bellBase * 1.5,
        endFreq: bellBase * 1.48,
        duration: subDur * 0.85,
        gain: 0.09,
        attack: 0.003,
      });
    }
  }

  public playSpell(spell: SpellSoundId): void {
    if (!this.canPlay("spell", 60)) return;

    switch (spell) {
      case "nova": {
        this.tone({
          type: "sine",
          freq: 132,
          endFreq: 28,
          duration: 0.38,
          gain: 0.32,
          attack: 0.004,
        });
        const chord = [146.83, 220, 261.63, 349.23];
        for (const f of chord) {
          this.tone({
            type: "sawtooth",
            freq: f,
            endFreq: f * 0.72,
            duration: 0.34,
            gain: 0.09,
            attack: 0.008,
            filterType: "lowpass",
            filterFreq: 2100,
            filterEndFreq: 260,
            filterQ: 2.1,
          });
        }
        this.noise({
          duration: 0.28,
          gain: 0.22,
          attack: 0.005,
          filterType: "bandpass",
          filterFreq: 1350,
          filterEndFreq: 220,
          filterQ: 1.2,
        });
        break;
      }
      case "volley": {
        for (let i = 0; i < 4; i++) {
          const delay = i * 0.036;
          const step = 1 + i * 0.08;
          this.tone({
            type: "triangle",
            freq: 820 * step,
            endFreq: 240 * step,
            duration: 0.075,
            gain: 0.15,
            delay,
            attack: 0.002,
          });
          this.noise({
            duration: 0.045,
            gain: 0.1,
            delay,
            attack: 0.002,
            filterType: "bandpass",
            filterFreq: 2400 * step,
            filterEndFreq: 950,
            filterQ: 2.6,
          });
        }
        break;
      }
      case "shell": {
        this.tone({
          type: "sine",
          freq: 196,
          endFreq: 146.83,
          duration: 0.32,
          gain: 0.24,
          attack: 0.004,
        });
        this.tone({
          type: "triangle",
          freq: 293.66,
          endFreq: 587.33,
          duration: 0.28,
          gain: 0.16,
          attack: 0.012,
        });
        this.tone({
          type: "sine",
          freq: 587.33,
          endFreq: 1174.66,
          duration: 0.24,
          gain: 0.11,
          delay: 0.03,
          attack: 0.01,
        });
        this.noise({
          duration: 0.09,
          gain: 0.1,
          filterType: "bandpass",
          filterFreq: 1650,
          filterEndFreq: 2800,
          filterQ: 3.5,
        });
        break;
      }
      case "frost": {
        const crystals = [1760, 2349.32, 3135.96, 3951.07];
        for (let i = 0; i < crystals.length; i++) {
          const f = crystals[i]!;
          this.tone({
            type: "sine",
            freq: f,
            endFreq: f * 0.96,
            duration: 0.19,
            gain: 0.11,
            delay: i * 0.026,
            attack: 0.002,
          });
        }
        this.noise({
          duration: 0.27,
          gain: 0.18,
          attack: 0.004,
          filterType: "bandpass",
          filterFreq: 3600,
          filterEndFreq: 1100,
          filterQ: 3.8,
        });
        break;
      }
      case "chain": {
        const arcs = [2400, 2850, 3320];
        for (let i = 0; i < arcs.length; i++) {
          const startF = arcs[i]!;
          const delay = i * 0.044;
          this.tone({
            type: "sawtooth",
            freq: startF,
            endFreq: 260 + i * 90,
            duration: 0.085,
            gain: 0.16,
            delay,
            attack: 0.001,
            filterType: "bandpass",
            filterFreq: 2800,
            filterEndFreq: 680,
            filterQ: 2.2,
          });
          this.noise({
            duration: 0.055,
            gain: 0.13,
            delay,
            attack: 0.001,
            filterType: "highpass",
            filterFreq: 2900,
            filterQ: 2.4,
          });
        }
        this.tone({
          type: "triangle",
          freq: 124,
          endFreq: 46,
          duration: 0.22,
          gain: 0.18,
          attack: 0.003,
        });
        break;
      }
      default: {
        this.tone({
          type: "triangle",
          freq: 440,
          endFreq: 880,
          duration: 0.18,
          gain: 0.18,
          attack: 0.005,
        });
        break;
      }
    }
  }

  public playPickup(templateId: string): void {
    if (templateId === "essence") {
      const tNow = nowMs();
      if (tNow - this.lastEssenceAt <= ESSENCE_COMBO_WINDOW_MS) {
        this.essenceCombo = Math.min(ESSENCE_MAX_COMBO, this.essenceCombo + 1);
      } else {
        this.essenceCombo = 0;
      }
      this.lastEssenceAt = tNow;

      if (!this.canPlay("essence", 28)) return;

      const semitones = ESSENCE_SEMITONE_LADDER[this.essenceCombo] ?? 0;
      const baseFreq = 587.33 * 2 ** (semitones / 12);
      const shimmerDetune = (Math.random() - 0.5) * 10;

      this.tone({
        type: "sine",
        freq: baseFreq,
        endFreq: baseFreq * 1.035,
        duration: 0.095,
        gain: 0.14,
        attack: 0.003,
        detune: shimmerDetune,
      });
      this.tone({
        type: "triangle",
        freq: baseFreq * 1.5,
        endFreq: baseFreq * 2,
        duration: 0.08,
        gain: 0.055 + (this.essenceCombo / ESSENCE_MAX_COMBO) * 0.045,
        delay: 0.012,
        attack: 0.003,
        detune: -shimmerDetune + 6,
      });
      return;
    }

    if (templateId === "relic") {
      if (!this.canPlay("relic", 90)) return;
      this.tone({
        type: "sine",
        freq: 146.83,
        endFreq: 146.83,
        duration: 0.42,
        gain: 0.22,
        attack: 0.01,
      });
      const notes = [293.66, 440, 587.33, 880];
      for (let i = 0; i < notes.length; i++) {
        const f = notes[i]!;
        this.tone({
          type: "triangle",
          freq: f,
          endFreq: f * 1.01,
          duration: 0.26,
          gain: 0.14,
          delay: i * 0.055,
          attack: 0.005,
        });
      }
      return;
    }

    if (!this.canPlay("pickup", 55)) return;

    switch (templateId) {
      case "vial": {
        const notes = [523.25, 659.25, 783.99];
        for (let i = 0; i < notes.length; i++) {
          const f = notes[i]!;
          this.tone({
            type: "sine",
            freq: f,
            endFreq: f * 1.04,
            duration: 0.13,
            gain: 0.14,
            delay: i * 0.042,
            attack: 0.004,
          });
        }
        break;
      }
      case "haste": {
        const notes = [587.33, 880, 1174.66];
        for (let i = 0; i < notes.length; i++) {
          const f = notes[i]!;
          this.tone({
            type: "triangle",
            freq: f,
            endFreq: f * 1.12,
            duration: 0.09,
            gain: 0.13,
            delay: i * 0.03,
            attack: 0.003,
          });
        }
        this.noise({
          duration: 0.12,
          gain: 0.09,
          filterType: "highpass",
          filterFreq: 1800,
          filterEndFreq: 4200,
          filterQ: 2.0,
        });
        break;
      }
      case "fang": {
        this.tone({
          type: "sawtooth",
          freq: 220,
          endFreq: 440,
          duration: 0.16,
          gain: 0.16,
          attack: 0.004,
          filterType: "bandpass",
          filterFreq: 1400,
          filterEndFreq: 2600,
          filterQ: 2.4,
        });
        this.noise({
          duration: 0.08,
          gain: 0.11,
          filterType: "bandpass",
          filterFreq: 2800,
          filterEndFreq: 1600,
          filterQ: 4.0,
        });
        break;
      }
      case "frenzy": {
        this.tone({
          type: "sawtooth",
          freq: 146.83,
          endFreq: 293.66,
          duration: 0.2,
          gain: 0.18,
          attack: 0.005,
          filterType: "lowpass",
          filterFreq: 1800,
          filterEndFreq: 900,
        });
        this.tone({
          type: "triangle",
          freq: 440,
          endFreq: 587.33,
          duration: 0.18,
          gain: 0.14,
          delay: 0.035,
          attack: 0.004,
        });
        break;
      }
      default: {
        this.tone({
          type: "sine",
          freq: 660,
          endFreq: 990,
          duration: 0.12,
          gain: 0.14,
          attack: 0.004,
        });
        break;
      }
    }
  }

  public playRaiseUnit(): void {
    if (!this.canPlay("raise", 80)) return;

    // Necromantic bone-rattle clicks
    const clicks = [0, 0.032, 0.068];
    for (let i = 0; i < clicks.length; i++) {
      const delay = clicks[i]!;
      this.noise({
        duration: 0.032,
        gain: 0.15,
        delay,
        attack: 0.001,
        filterType: "bandpass",
        filterFreq: 1650 + i * 340,
        filterQ: 4.2,
      });
    }

    // Low dark brass swell (D2 + A2 + D3)
    const brass = [73.42, 110, 146.83];
    for (const f of brass) {
      this.tone({
        type: "sawtooth",
        freq: f * 0.96,
        midFreq: f * 1.02,
        midRatio: 0.55,
        endFreq: f,
        duration: 0.36,
        gain: 0.12,
        attack: 0.045,
        filterType: "lowpass",
        filterFreq: 260,
        filterEndFreq: 920,
        filterQ: 2.2,
      });
    }
  }

  public playLevelUp(): void {
    if (!this.canPlay("levelup", 180)) return;

    // Deep cathedral sub-foundation
    this.tone({
      type: "sine",
      freq: 73.42,
      endFreq: 73.42,
      duration: 0.55,
      gain: 0.24,
      attack: 0.01,
    });

    // Dark gothic minor-to-fifth fanfare (D4 -> F4 -> A4 -> D5)
    const fanfare = [
      { freq: 293.66, delay: 0, dur: 0.22 },
      { freq: 349.23, delay: 0.075, dur: 0.22 },
      { freq: 440.0, delay: 0.15, dur: 0.32 },
      { freq: 587.33, delay: 0.23, dur: 0.42 },
    ];
    for (const note of fanfare) {
      this.tone({
        type: "sawtooth",
        freq: note.freq,
        endFreq: note.freq * 1.004,
        duration: note.dur,
        gain: 0.14,
        delay: note.delay,
        attack: 0.008,
        filterType: "lowpass",
        filterFreq: 1900,
        filterEndFreq: 950,
      });
      this.tone({
        type: "triangle",
        freq: note.freq * 1.5,
        endFreq: note.freq * 1.5,
        duration: note.dur * 0.9,
        gain: 0.08,
        delay: note.delay + 0.01,
        attack: 0.008,
      });
    }
  }

  public playUpgradeChosen(isWeaponOrEvolution?: boolean): void {
    if (!this.canPlay("upgrade", 90)) return;

    // Heavy rune-anvil lock-in thud
    this.tone({
      type: "sine",
      freq: 118,
      endFreq: 40,
      duration: 0.22,
      gain: 0.26,
      attack: 0.002,
    });
    this.noise({
      duration: 0.055,
      gain: 0.14,
      attack: 0.001,
      filterType: "bandpass",
      filterFreq: 2100,
      filterEndFreq: 780,
      filterQ: 3.0,
    });

    const chord = isWeaponOrEvolution ? [293.66, 440, 587.33, 880, 1174.66] : [293.66, 440, 587.33];
    for (let i = 0; i < chord.length; i++) {
      const f = chord[i]!;
      this.tone({
        type: isWeaponOrEvolution ? "sawtooth" : "triangle",
        freq: f,
        endFreq: f * 1.005,
        duration: isWeaponOrEvolution ? 0.36 : 0.24,
        gain: isWeaponOrEvolution ? 0.12 : 0.11,
        delay: i * 0.022,
        attack: 0.004,
        filterType: "lowpass",
        filterFreq: 2600,
        filterEndFreq: 980,
      });
    }
  }

  public playContract(kind: ContractSoundKind): void {
    if (!this.canPlay(`contract:${kind}`, 80)) return;

    switch (kind) {
      case "posted": {
        // Wax-seal stamp + parchment snap
        this.tone({
          type: "triangle",
          freq: 145,
          endFreq: 48,
          duration: 0.14,
          gain: 0.22,
          attack: 0.002,
        });
        this.noise({
          duration: 0.06,
          gain: 0.14,
          filterType: "bandpass",
          filterFreq: 1850,
          filterEndFreq: 750,
          filterQ: 2.5,
        });
        this.tone({
          type: "sine",
          freq: 440,
          endFreq: 554.37,
          duration: 0.18,
          gain: 0.12,
          delay: 0.04,
          attack: 0.005,
        });
        break;
      }
      case "accepted": {
        // War-horn call
        const hornNotes = [146.83, 220, 293.66];
        for (let i = 0; i < hornNotes.length; i++) {
          const f = hornNotes[i]!;
          this.tone({
            type: "sawtooth",
            freq: f * 0.95,
            midFreq: f,
            midRatio: 0.3,
            endFreq: f * 1.01,
            duration: 0.38,
            gain: 0.13,
            delay: i * 0.03,
            attack: 0.035,
            filterType: "lowpass",
            filterFreq: 340,
            filterEndFreq: 1150,
            filterQ: 2.4,
          });
        }
        break;
      }
      case "settled": {
        // Coin cascade + triumphant fifth chord
        const coins = [1975.53, 2349.32, 2637.02, 2959.96, 3520];
        for (let i = 0; i < coins.length; i++) {
          const f = coins[i]!;
          this.tone({
            type: "sine",
            freq: f,
            endFreq: f * 1.015,
            duration: 0.14,
            gain: 0.11,
            delay: i * 0.042,
            attack: 0.001,
          });
        }
        this.tone({
          type: "triangle",
          freq: 293.66,
          endFreq: 293.66,
          duration: 0.34,
          gain: 0.14,
          attack: 0.01,
        });
        this.tone({
          type: "triangle",
          freq: 440,
          endFreq: 440,
          duration: 0.34,
          gain: 0.12,
          delay: 0.03,
          attack: 0.01,
        });
        break;
      }
      case "alert": {
        this.tone({
          type: "sawtooth",
          freq: 440,
          endFreq: 415.3,
          duration: 0.14,
          gain: 0.15,
          attack: 0.004,
          filterType: "lowpass",
          filterFreq: 1500,
          filterEndFreq: 680,
        });
        this.tone({
          type: "sawtooth",
          freq: 622.25,
          endFreq: 587.33,
          duration: 0.18,
          gain: 0.15,
          delay: 0.11,
          attack: 0.004,
          filterType: "lowpass",
          filterFreq: 1600,
          filterEndFreq: 720,
        });
        break;
      }
    }
  }

  public playHurt(hpRatio: number): void {
    if (!this.canPlay("hurt", 85)) return;

    // Visceral low body-blow thud + pain crunch
    this.tone({
      type: "sine",
      freq: 138,
      endFreq: 36,
      duration: 0.145,
      gain: 0.28,
      attack: 0.002,
    });
    this.tone({
      type: "sawtooth",
      freq: 311.13,
      endFreq: 220,
      duration: 0.11,
      gain: 0.13,
      attack: 0.003,
      filterType: "lowpass",
      filterFreq: 920,
      filterEndFreq: 280,
    });
    this.noise({
      duration: 0.09,
      gain: 0.17,
      attack: 0.002,
      filterType: "bandpass",
      filterFreq: 720,
      filterEndFreq: 220,
      filterQ: 1.6,
    });

    if (hpRatio > 0 && hpRatio < 0.35 && this.canPlay("heartbeat", 750)) {
      // Double "lub-dub" low heartbeat thump
      this.tone({
        type: "sine",
        freq: 70,
        endFreq: 32,
        duration: 0.14,
        gain: 0.26,
        delay: 0.045,
        attack: 0.008,
      });
      this.tone({
        type: "sine",
        freq: 82,
        endFreq: 35,
        duration: 0.16,
        gain: 0.22,
        delay: 0.21,
        attack: 0.008,
      });
    }
  }

  public playExtract(): void {
    if (!this.canPlay("extract", 250)) return;

    const portalNotes = [293.66, 440, 587.33, 739.99, 880, 1174.66];
    for (let i = 0; i < portalNotes.length; i++) {
      const f = portalNotes[i]!;
      const delay = i * 0.065;
      this.tone({
        type: "triangle",
        freq: f,
        endFreq: f * 1.06,
        duration: 0.34,
        gain: 0.13,
        delay,
        attack: 0.012,
        detune: -8,
      });
      this.tone({
        type: "sine",
        freq: f * 1.5,
        endFreq: f * 1.58,
        duration: 0.28,
        gain: 0.08,
        delay: delay + 0.015,
        attack: 0.015,
        detune: 8,
      });
    }
    this.noise({
      duration: 0.55,
      gain: 0.14,
      attack: 0.04,
      filterType: "bandpass",
      filterFreq: 420,
      filterEndFreq: 2800,
      filterQ: 3.2,
    });
  }

  public playDeath(): void {
    if (!this.canPlay("death", 400)) return;

    // Crushing sub-bass descent
    this.tone({
      type: "sine",
      freq: 110,
      endFreq: 24,
      duration: 0.82,
      gain: 0.32,
      attack: 0.008,
    });

    // Dark descending funeral toll (A4 -> Eb4 -> D3 -> D2)
    const toll = [
      { freq: 440, delay: 0, dur: 0.45 },
      { freq: 311.13, delay: 0.14, dur: 0.48 },
      { freq: 146.83, delay: 0.3, dur: 0.62 },
      { freq: 73.42, delay: 0.44, dur: 0.72 },
    ];
    for (const note of toll) {
      this.tone({
        type: "sawtooth",
        freq: note.freq,
        endFreq: note.freq * 0.92,
        duration: note.dur,
        gain: 0.14,
        delay: note.delay,
        attack: 0.01,
        filterType: "lowpass",
        filterFreq: 980,
        filterEndFreq: 190,
        filterQ: 2.0,
      });
    }

    this.noise({
      duration: 0.65,
      gain: 0.14,
      attack: 0.02,
      filterType: "bandpass",
      filterFreq: 920,
      filterEndFreq: 160,
      filterQ: 1.8,
    });
  }

  public playWaveHorn(): void {
    if (!this.canPlay("wave_horn", 1200)) return;

    // Deep sub-foundation
    this.tone({
      type: "sine",
      freq: 55,
      endFreq: 49,
      duration: 0.95,
      gain: 0.24,
      attack: 0.08,
    });

    // Ancient catacomb brass horn chord (G2 + D3 + G3)
    const hornNotes = [
      { freq: 98, mid: 102, end: 96, gain: 0.18, detune: -6, delay: 0 },
      { freq: 146.83, mid: 152, end: 145, gain: 0.14, detune: 7, delay: 0.04 },
      { freq: 196, mid: 204, end: 194, gain: 0.1, detune: -4, delay: 0.09 },
    ];
    for (const n of hornNotes) {
      this.tone({
        type: "sawtooth",
        freq: n.freq,
        midFreq: n.mid,
        midRatio: 0.42,
        endFreq: n.end,
        duration: 0.88,
        gain: n.gain,
        delay: n.delay,
        attack: 0.12,
        detune: n.detune,
        filterType: "lowpass",
        filterFreq: 340,
        filterEndFreq: 1120,
        filterQ: 3.1,
      });
    }

    this.noise({
      duration: 0.72,
      gain: 0.09,
      attack: 0.1,
      filterType: "bandpass",
      filterFreq: 420,
      filterEndFreq: 760,
      filterQ: 2.6,
    });
  }

  private canPlay(category: string, minIntervalMs: number): boolean {
    if (this.muted) return false;
    if (!this.ctx || !this.compressor) return false;
    if (this.activeVoices >= MAX_ACTIVE_VOICES) return false;

    const t = nowMs();
    const prev = this.lastPlayedAt.get(category);
    if (prev !== undefined && t - prev < minIntervalMs) {
      return false;
    }
    this.lastPlayedAt.set(category, t);

    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    return true;
  }

  private tone(spec: ToneSpec): void {
    const ctx = this.ctx;
    const dest = this.compressor;
    if (!ctx || !dest || this.muted || this.activeVoices >= MAX_ACTIVE_VOICES) return;

    try {
      const start = ctx.currentTime + (spec.delay ?? 0);
      const dur = Math.max(0.015, spec.duration);
      const attack = Math.min(dur * 0.45, Math.max(0.001, spec.attack ?? 0.004));
      const end = start + dur;

      const osc = ctx.createOscillator();
      osc.type = spec.type ?? "triangle";
      osc.frequency.setValueAtTime(Math.max(16, spec.freq), start);
      if (spec.detune) {
        osc.detune.setValueAtTime(spec.detune, start);
      }
      if (spec.midFreq !== undefined) {
        const midTime = start + dur * Math.min(0.9, Math.max(0.1, spec.midRatio ?? 0.45));
        osc.frequency.exponentialRampToValueAtTime(Math.max(16, spec.midFreq), midTime);
      }
      if (spec.endFreq !== undefined && spec.endFreq !== spec.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(16, spec.endFreq), end);
      }

      const env = ctx.createGain();
      const peakGain = Math.max(0.0002, Math.min(0.6, spec.gain));
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakGain, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      let lastNode: AudioNode = osc;

      if (spec.filterType && spec.filterFreq !== undefined) {
        const filter = ctx.createBiquadFilter();
        filter.type = spec.filterType;
        filter.frequency.setValueAtTime(Math.max(24, spec.filterFreq), start);
        if (spec.filterEndFreq !== undefined) {
          filter.frequency.exponentialRampToValueAtTime(Math.max(24, spec.filterEndFreq), end);
        }
        if (spec.filterQ !== undefined) {
          filter.Q.setValueAtTime(spec.filterQ, start);
        }
        lastNode.connect(filter);
        lastNode = filter;
      }

      lastNode.connect(env);
      let outNode: AudioNode = env;

      if (spec.pan !== undefined && typeof ctx.createStereoPanner === "function") {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(Math.max(-1, Math.min(1, spec.pan)), start);
        outNode.connect(panner);
        outNode = panner;
      }

      outNode.connect(dest);

      this.activeVoices++;
      osc.onended = () => {
        this.activeVoices = Math.max(0, this.activeVoices - 1);
        try {
          outNode.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      };

      osc.start(start);
      osc.stop(end + 0.005);
    } catch {
      // Ignore transient scheduling errors
    }
  }

  private noise(spec: NoiseSpec): void {
    const ctx = this.ctx;
    const dest = this.compressor;
    const buffer = this.noiseBuffer;
    if (!ctx || !dest || !buffer || this.muted || this.activeVoices >= MAX_ACTIVE_VOICES) return;

    try {
      const start = ctx.currentTime + (spec.delay ?? 0);
      const dur = Math.max(0.015, spec.duration);
      const attack = Math.min(dur * 0.4, Math.max(0.001, spec.attack ?? 0.002));
      const end = start + dur;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (spec.playbackRate !== undefined) {
        src.playbackRate.setValueAtTime(spec.playbackRate, start);
      }

      const filter = ctx.createBiquadFilter();
      filter.type = spec.filterType ?? "bandpass";
      filter.frequency.setValueAtTime(Math.max(24, spec.filterFreq), start);
      if (spec.filterEndFreq !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(24, spec.filterEndFreq), end);
      }
      filter.Q.setValueAtTime(spec.filterQ ?? 1.8, start);

      const env = ctx.createGain();
      const peakGain = Math.max(0.0002, Math.min(0.5, spec.gain));
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakGain, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      src.connect(filter);
      filter.connect(env);
      let outNode: AudioNode = env;

      if (spec.pan !== undefined && typeof ctx.createStereoPanner === "function") {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(Math.max(-1, Math.min(1, spec.pan)), start);
        outNode.connect(panner);
        outNode = panner;
      }

      outNode.connect(dest);

      this.activeVoices++;
      src.onended = () => {
        this.activeVoices = Math.max(0, this.activeVoices - 1);
        try {
          outNode.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      };

      const maxOffset = Math.max(0, buffer.duration - dur - 0.02);
      const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
      src.start(start, offset, dur + 0.01);
      src.stop(end + 0.005);
    } catch {
      // Ignore transient scheduling errors
    }
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const sampleRate = ctx.sampleRate || 44100;
    const length = Math.floor(sampleRate * 1.5);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const channel = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // Blend white noise with warm pink-ish filtering for organic bone/fire texture
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.95 * b2 + white * 0.048;
      channel[i] = white * 0.68 + (b0 + b1 + b2) * 0.32;
    }
    return buffer;
  }
}

export const sfx = new SoundEngine();
