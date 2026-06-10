"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Hex } from "viem";
import ConnectAccount from "./ConnectAccount";
import Toast from "./Toast";
import {
  CIRCLES_MINIAPP_URL,
  getConnectedAddress,
  initCircles,
  isMiniappMode,
  joinPvpGame,
  submitGameResult,
  subscribeWallet,
} from "@/lib/circles";
import { encodeApprove } from "@/lib/contract";
import { VALID_GUESSES } from "@/lib/words";
import { commitWord } from "@/lib/duel/commitment";
import { encodeSubmitFeedbackFromProof } from "@/lib/duel";
import {
  DEFAULT_ZK_DUEL_STAKE,
  FRONTEND_ZK_DUEL_ENABLED,
  ZK_DUEL_ADDRESS,
  assertOnchainDictRoot,
  computeCreatorMatchId,
  encodeCreateMatch,
  encodeJoinMatch,
  encodeSettle,
  encodeSubmitGuess,
  encodeWithdraw,
  isParticipant,
  loadLastZkDuel,
  loadZkAnswers,
  loadZkDuelSecret,
  matchBinding,
  myAnswerTrack,
  myGuessTrack,
  newNonce,
  newSalt,
  readZkDuelToken,
  readZkMatch,
  saveZkDuelSecret,
  type StoredZkDuelSecret,
  type ZkMatchState,
  type ZkTrackState,
} from "@/lib/duel/frontend";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Mode = "menu" | "create" | "join" | "active";
type Busy =
  | "creating"
  | "joining"
  | "guessing"
  | "generating-proof"
  | "submitting-feedback"
  | "settling"
  | "withdrawing"
  | null;

export default function ZkDuelGame() {
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );
  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState<Busy>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<Hex | null>(null);
  const [state, setState] = useState<ZkMatchState | null>(null);
  const [secret, setSecret] = useState("");
  const [salt, setSalt] = useState("");
  const [nonce, setNonce] = useState("");
  const [stake, setStake] = useState(() =>
    DEFAULT_ZK_DUEL_STAKE > 0n ? formatUnits(DEFAULT_ZK_DUEL_STAKE, 18) : "1",
  );
  const [joinMatchId, setJoinMatchId] = useState("");
  const [guess, setGuess] = useState("");
  const [storedSecret, setStoredSecret] = useState<StoredZkDuelSecret | null>(
    null,
  );

  useEffect(() => {
    initCircles();
    const unsubscribe = subscribeWallet(setWalletAddress);
    /* eslint-disable react-hooks/set-state-in-effect */
    if (typeof window !== "undefined") {
      const requested = new URLSearchParams(window.location.search).get(
        "match",
      );
      const restored = requested ?? loadLastZkDuel();
      if (restored && /^0x[0-9a-fA-F]{64}$/.test(restored)) {
        setMatchId(restored as Hex);
        setJoinMatchId(restored);
        setMode("active");
      }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    return unsubscribe;
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!walletAddress || !matchId) {
      setStoredSecret(null);
      return;
    }
    setStoredSecret(loadZkDuelSecret(walletAddress, matchId));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [walletAddress, matchId]);

  const refreshState = useCallback(async () => {
    if (!matchId) return;
    try {
      const next = await readZkMatch(matchId, walletAddress);
      assertOnchainDictRoot(next);
      setState(next);
    } catch (err) {
      console.error("ZK duel read failed:", err);
      setToast("Couldn't read the duel contract state");
    }
  }, [matchId, walletAddress]);

  useEffect(() => {
    if (mode !== "active" || !matchId) return;
    let active = true;
    const tick = async () => {
      if (!active) return;
      await refreshState();
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [mode, matchId, refreshState]);

  const myTrack = useMemo(
    () => (state && walletAddress ? myGuessTrack(state, walletAddress) : null),
    [state, walletAddress],
  );
  const answerTrack = useMemo(
    () => (state && walletAddress ? myAnswerTrack(state, walletAddress) : null),
    [state, walletAddress],
  );

  const makeCreate = useCallback(async () => {
    if (!walletAddress || !ZK_DUEL_ADDRESS) return;
    const cleanSecret = normalizeWord(secret);
    if (!cleanSecret || !VALID_GUESSES.has(cleanSecret)) {
      setToast("Pick a valid 5-letter secret word");
      return;
    }
    let parsedStake: bigint;
    try {
      parsedStake = parseUnits(stake || "0", 18);
    } catch {
      setToast("Stake must be a number of CRC");
      return;
    }
    if (parsedStake <= 0n) {
      setToast("Stake must be greater than zero");
      return;
    }
    setBusy("creating");
    try {
      const nonceValue = nonce ? BigInt(nonce) : newNonce();
      const saltValue = salt ? BigInt(salt) : newSalt();
      const id = computeCreatorMatchId(walletAddress, nonceValue);
      const commitment = await commitWord(
        cleanSecret,
        saltValue,
        matchBinding(id),
      );
      const token = await readZkDuelToken();
      await joinPvpGame({
        escrow: ZK_DUEL_ADDRESS,
        token,
        approveData: encodeApprove(ZK_DUEL_ADDRESS, parsedStake),
        joinData: encodeCreateMatch(nonceValue, commitment, parsedStake),
        player: walletAddress,
        stake: parsedStake,
      });
      const saved: StoredZkDuelSecret = {
        matchId: id,
        role: "creator",
        secret: cleanSecret,
        salt: saltValue.toString(),
        nonce: nonceValue.toString(),
        stake: parsedStake.toString(),
        createdAt: Date.now(),
      };
      saveZkDuelSecret(walletAddress, saved);
      setStoredSecret(saved);
      setMatchId(id);
      setJoinMatchId(id);
      setMode("active");
      setToast("Match created. Share the invite link with your opponent.");
    } catch (err) {
      console.error("ZK duel create failed:", err);
      setToast("Create transaction rejected or reverted");
    } finally {
      setBusy(null);
    }
  }, [nonce, salt, secret, stake, walletAddress]);

  const makeJoin = useCallback(async () => {
    if (!walletAddress || !ZK_DUEL_ADDRESS) return;
    const id = normalizeMatchId(joinMatchId);
    const cleanSecret = normalizeWord(secret);
    if (!id) {
      setToast("Paste a valid match id or invite link");
      return;
    }
    if (!cleanSecret || !VALID_GUESSES.has(cleanSecret)) {
      setToast("Pick a valid 5-letter secret word");
      return;
    }
    setBusy("joining");
    try {
      const before = await readZkMatch(id, walletAddress);
      assertOnchainDictRoot(before);
      if (before.status !== "open") {
        setToast("That match is not open for joining");
        return;
      }
      const saltValue = salt ? BigInt(salt) : newSalt();
      const commitment = await commitWord(
        cleanSecret,
        saltValue,
        matchBinding(id),
      );
      await joinPvpGame({
        escrow: ZK_DUEL_ADDRESS,
        token: before.token,
        approveData: encodeApprove(ZK_DUEL_ADDRESS, before.stake),
        joinData: encodeJoinMatch(id, commitment),
        player: walletAddress,
        stake: before.stake,
      });
      const saved: StoredZkDuelSecret = {
        matchId: id,
        role: "joiner",
        secret: cleanSecret,
        salt: saltValue.toString(),
        stake: before.stake.toString(),
        createdAt: Date.now(),
      };
      saveZkDuelSecret(walletAddress, saved);
      setStoredSecret(saved);
      setMatchId(id);
      setMode("active");
      setToast("Joined. The duel is live once the transaction lands.");
    } catch (err) {
      console.error("ZK duel join failed:", err);
      setToast("Join transaction rejected or reverted");
    } finally {
      setBusy(null);
    }
  }, [joinMatchId, salt, secret, walletAddress]);

  const submitGuess = useCallback(async () => {
    if (!matchId || !ZK_DUEL_ADDRESS) return;
    const cleanGuess = normalizeWord(guess);
    if (!cleanGuess || !VALID_GUESSES.has(cleanGuess)) {
      setToast("Enter a valid 5-letter guess");
      return;
    }
    setBusy("guessing");
    try {
      await submitGameResult(
        ZK_DUEL_ADDRESS,
        encodeSubmitGuess(matchId, cleanGuess),
      );
      setGuess("");
      setToast("Guess submitted on-chain. Waiting for feedback proof…");
      await refreshState();
    } catch (err) {
      console.error("ZK duel guess failed:", err);
      setToast("Guess transaction rejected or reverted");
    } finally {
      setBusy(null);
    }
  }, [guess, matchId, refreshState]);

  const submitFeedback = useCallback(async () => {
    if (!matchId || !ZK_DUEL_ADDRESS || !answerTrack || !storedSecret) return;
    setBusy("generating-proof");
    try {
      const answers = await loadZkAnswers();
      const { generateFeedbackProof } = await import("@/lib/duel/prove");
      const proof = await generateFeedbackProof({
        secret: storedSecret.secret,
        salt: BigInt(storedSecret.salt),
        matchBinding: matchBinding(matchId),
        guess: answerTrack.guessWord,
        answers,
      });
      setBusy("submitting-feedback");
      await submitGameResult(
        ZK_DUEL_ADDRESS,
        encodeSubmitFeedbackFromProof(matchId, proof),
      );
      setToast("Proof accepted. Feedback submitted on-chain.");
      await refreshState();
    } catch (err) {
      console.error("ZK duel feedback proof failed:", err);
      setToast("Proof failed or feedback transaction reverted");
    } finally {
      setBusy(null);
    }
  }, [answerTrack, matchId, refreshState, storedSecret]);

  const settle = useCallback(async () => {
    if (!matchId || !ZK_DUEL_ADDRESS) return;
    setBusy("settling");
    try {
      await submitGameResult(ZK_DUEL_ADDRESS, encodeSettle(matchId));
      setToast("Settle submitted.");
      await refreshState();
    } catch (err) {
      console.error("ZK duel settle failed:", err);
      setToast("Settle is not available yet, or transaction reverted");
    } finally {
      setBusy(null);
    }
  }, [matchId, refreshState]);

  const withdraw = useCallback(async () => {
    if (!ZK_DUEL_ADDRESS) return;
    setBusy("withdrawing");
    try {
      await submitGameResult(ZK_DUEL_ADDRESS, encodeWithdraw());
      setToast("Withdraw submitted.");
      await refreshState();
    } catch (err) {
      console.error("ZK duel withdraw failed:", err);
      setToast("Withdraw transaction rejected or reverted");
    } finally {
      setBusy(null);
    }
  }, [refreshState]);

  const title = (
    <h1 className="text-2xl font-extrabold tracking-tight">
      <span className="text-secondary">ZK Wordle</span>{" "}
      <span className="text-primary">Duel</span>
    </h1>
  );

  if (!FRONTEND_ZK_DUEL_ENABLED || !ZK_DUEL_ADDRESS) {
    return (
      <Screen>
        {title}
        <p className="text-muted">
          ZK duels are not configured in this frontend build yet.
        </p>
        <p className="text-faint text-xs">
          Set NEXT_PUBLIC_ZK_DUEL_ENABLED=true and NEXT_PUBLIC_ZK_DUEL_ADDRESS.
        </p>
      </Screen>
    );
  }

  if (!walletAddress) {
    const standalone = !isMiniappMode();
    return (
      <Screen>
        {title}
        <p className="text-muted">
          {standalone
            ? "ZK duels run inside the Circles app wallet."
            : "Connect your Circles wallet to create or join a duel."}
        </p>
        {standalone ? (
          <a className="primary-button" href={CIRCLES_MINIAPP_URL}>
            Open in Circles
          </a>
        ) : (
          <ConnectAccount />
        )}
      </Screen>
    );
  }

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-5 px-4 text-center">
      {title}
      <p className="text-xs text-muted break-all">Wallet: {walletAddress}</p>
      {mode === "menu" && (
        <div className="grid w-full gap-3 sm:grid-cols-3">
          <button className="panel-button" onClick={() => setMode("create")}>
            Create duel
          </button>
          <button className="panel-button" onClick={() => setMode("join")}>
            Join duel
          </button>
          <button
            className="panel-button"
            onClick={() => {
              const last = loadLastZkDuel();
              if (last) {
                setMatchId(last);
                setMode("active");
              } else setToast("No saved ZK duel found on this device");
            }}
          >
            Resume local duel
          </button>
        </div>
      )}

      {(mode === "create" || mode === "join") && (
        <div className="w-full rounded-2xl border border-border bg-surface/80 p-4 text-left shadow-sm">
          <FormLabel label="Secret answer word">
            <input
              className="input"
              value={secret}
              onChange={(e) => setSecret(e.target.value.toLowerCase())}
              maxLength={5}
              placeholder="crane"
            />
          </FormLabel>
          <FormLabel label="Salt field element (optional; generated if blank)">
            <input
              className="input"
              value={salt}
              onChange={(e) => setSalt(e.target.value)}
              placeholder="leave blank for random salt"
            />
          </FormLabel>
          {mode === "create" ? (
            <>
              <FormLabel label="Nonce (optional; generated if blank)">
                <input
                  className="input"
                  value={nonce}
                  onChange={(e) => setNonce(e.target.value)}
                  placeholder="leave blank for random nonce"
                />
              </FormLabel>
              <FormLabel label="Stake (CRC)">
                <input
                  className="input"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  inputMode="decimal"
                />
              </FormLabel>
              <button
                className="primary-button mt-3"
                disabled={busy !== null}
                onClick={makeCreate}
              >
                {busy === "creating"
                  ? "Confirm approve + create…"
                  : "Create ZK duel"}
              </button>
            </>
          ) : (
            <>
              <FormLabel label="Match id or invite link">
                <input
                  className="input"
                  value={joinMatchId}
                  onChange={(e) => setJoinMatchId(e.target.value)}
                  placeholder="0x…"
                />
              </FormLabel>
              <button
                className="primary-button mt-3"
                disabled={busy !== null}
                onClick={makeJoin}
              >
                {busy === "joining"
                  ? "Confirm approve + join…"
                  : "Join ZK duel"}
              </button>
            </>
          )}
        </div>
      )}

      {mode === "active" && matchId && (
        <ActiveDuel
          matchId={matchId}
          state={state}
          myTrack={myTrack}
          answerTrack={answerTrack}
          storedSecret={storedSecret}
          guess={guess}
          busy={busy}
          onGuessChange={setGuess}
          onSubmitGuess={submitGuess}
          onSubmitFeedback={submitFeedback}
          onRefresh={refreshState}
          onSettle={settle}
          onWithdraw={withdraw}
          onLeave={() => setMode("menu")}
          walletAddress={walletAddress}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function ActiveDuel(props: {
  matchId: Hex;
  state: ZkMatchState | null;
  myTrack: ZkTrackState | null;
  answerTrack: ZkTrackState | null;
  storedSecret: StoredZkDuelSecret | null;
  guess: string;
  busy: Busy;
  walletAddress: string;
  onGuessChange: (guess: string) => void;
  onSubmitGuess: () => void;
  onSubmitFeedback: () => void;
  onRefresh: () => void;
  onSettle: () => void;
  onWithdraw: () => void;
  onLeave: () => void;
}) {
  const invite =
    typeof window === "undefined"
      ? props.matchId
      : `${window.location.origin}/zk-duel?match=${props.matchId}`;
  const state = props.state;
  const participant = state ? isParticipant(state, props.walletAddress) : true;
  const canGuess =
    state?.status === "active" &&
    participant &&
    props.myTrack &&
    !props.myTrack.pendingGuess &&
    !props.myTrack.solved &&
    props.myTrack.guessCount < 6;
  const pendingForMe =
    state?.status === "active" && props.answerTrack?.pendingGuess === true;

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="rounded-2xl border border-border bg-surface/80 p-4 text-left shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold">Match</p>
            <p className="break-all text-xs text-muted">{props.matchId}</p>
          </div>
          <button className="small-button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <p className="mt-2 text-sm text-muted break-all">Invite: {invite}</p>
        {state ? (
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <Stat label="Status" value={state.status} />
            <Stat label="Stake" value={`${formatUnits(state.stake, 18)} CRC`} />
            <Stat label="Player A" value={shortAddress(state.playerA)} />
            <Stat
              label="Player B"
              value={
                state.playerB === ZERO_ADDRESS
                  ? "waiting"
                  : shortAddress(state.playerB)
              }
            />
          </div>
        ) : (
          <p className="mt-3 text-muted animate-pulse">
            Reading contract state…
          </p>
        )}
      </div>

      {state?.status === "open" && (
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm text-muted">
          Waiting for an opponent to join. Your secret and salt are stored only
          in this browser so you can answer their guesses later.
        </div>
      )}

      {state?.status === "active" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TrackCard title="Your guesses" track={props.myTrack} />
          <TrackCard
            title="Opponent guesses to answer"
            track={props.answerTrack}
          />
        </div>
      )}

      {pendingForMe && (
        <div className="rounded-2xl border border-present bg-surface/80 p-4 text-left shadow-sm">
          <p className="font-bold">
            Pending opponent guess: {props.answerTrack?.guessWord.toUpperCase()}
          </p>
          <p className="text-sm text-muted">
            Generate the local Noir/UltraHonk proof and submit it to
            WordleDuel.submitFeedback.
          </p>
          {!props.storedSecret && (
            <p className="mt-2 text-sm text-secondary">
              Missing local secret/salt for this wallet and match. Rejoin on the
              original browser/device to answer this guess.
            </p>
          )}
          <button
            className="primary-button mt-3"
            disabled={!props.storedSecret || props.busy !== null}
            onClick={props.onSubmitFeedback}
          >
            {props.busy === "generating-proof"
              ? "Generating proof…"
              : props.busy === "submitting-feedback"
                ? "Submitting feedback…"
                : "Generate proof + submit feedback"}
          </button>
        </div>
      )}

      {canGuess && (
        <div className="rounded-2xl border border-border bg-surface/80 p-4 text-left shadow-sm">
          <FormLabel label="Plaintext guess submitted on-chain">
            <input
              className="input"
              value={props.guess}
              maxLength={5}
              onChange={(e) =>
                props.onGuessChange(e.target.value.toLowerCase())
              }
              placeholder="react"
            />
          </FormLabel>
          <button
            className="primary-button mt-3"
            disabled={props.busy !== null}
            onClick={props.onSubmitGuess}
          >
            {props.busy === "guessing" ? "Submitting guess…" : "Submit guess"}
          </button>
        </div>
      )}

      {props.myTrack?.pendingGuess && (
        <p className="text-sm text-muted">
          Your latest guess is pending opponent feedback.
        </p>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        <button
          className="small-button"
          disabled={props.busy !== null}
          onClick={props.onSettle}
        >
          {props.busy === "settling" ? "Settling…" : "Settle"}
        </button>
        <button
          className="small-button"
          disabled={props.busy !== null || !state || state.withdrawable === 0n}
          onClick={props.onWithdraw}
        >
          {props.busy === "withdrawing"
            ? "Withdrawing…"
            : `Withdraw ${state ? formatUnits(state.withdrawable, 18) : "0"} CRC`}
        </button>
        <button className="small-button" onClick={props.onLeave}>
          Back
        </button>
      </div>
    </div>
  );
}

function TrackCard(props: { title: string; track: ZkTrackState | null }) {
  const track = props.track;
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 text-left shadow-sm">
      <p className="font-bold">{props.title}</p>
      {track ? (
        <div className="mt-2 space-y-1 text-sm text-muted">
          <p>Guesses: {track.guessCount}/6</p>
          <p>
            Pending:{" "}
            {track.pendingGuess ? track.guessWord.toUpperCase() : "none"}
          </p>
          <p>
            Solved: {track.solved ? `yes, at ${track.solvedAtGuess}` : "no"}
          </p>
          <p>
            Tiebreak tiles: {track.greens} green / {track.oranges} orange
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">Not seated in this match.</p>
      )}
    </div>
  );
}

function FormLabel(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block text-sm font-semibold text-muted first:mt-0">
      {props.label}
      {props.children}
    </label>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2">
      <p className="text-xs text-faint">{props.label}</p>
      <p className="break-all font-semibold">{props.value}</p>
    </div>
  );
}

function Screen(props: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 px-4 text-center">
      {props.children}
    </div>
  );
}

function normalizeWord(value: string): string | null {
  const word = value.trim().toLowerCase();
  return /^[a-z]{5}$/.test(word) ? word : null;
}

function normalizeMatchId(value: string): Hex | null {
  const match = value.match(/0x[0-9a-fA-F]{64}/);
  return match ? (match[0] as Hex) : null;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
