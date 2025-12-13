// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import jsPDF from "jspdf";
import "jspdf-autotable";
import { LOGOS, urlToBase64 } from "./logoBase64";

// ---------- PDF HELPERS (paste once globally) ----------

function buildSummaryFromRoom(room) {
  const summary = {};
  if (!room) return summary;

  for (const [tid, t] of Object.entries(room.teams || {})) {
    const teamData = {
      purse: Number(t.purse || 0),
      rtmLeft: Number(t.rtmLeft || 0),
      players: (t.players || []).map(p => ({
        Name: p.Name,
        Role: p.Role,
        amount: Number(p.amount || 0),
        Base: Number(p.Base || 0),
        Country: p.Country,
      }))
    };

    const evalResult = evaluateTeam(teamData);

    summary[tid] = {
      ...teamData,
      rating: evalResult.rating,
      strengths: evalResult.strengths,
      weaknesses: evalResult.weaknesses,
      mvp: evalResult.mvp,
      bestValue: evalResult.bestValue
    };
  }

  return summary;
}

/*
  Full App.jsx - Option B (Advanced sounds)
  - No ACK callbacks (works with your server)
  - All JSX/braces fixed
  - Auto-navigation when roomState.phase === 'bidding'
  - Host-only skip/end
  - Advanced sound cues (going once/twice)
  - Defensive checks for null roomState
*/

const socket = io("https://ipl-auction-backend1.onrender.com", { transports: ["websocket"],}); // change origin if needed

const TEAM_LOGOS = {
  CSK: "/logos/csk.png",
  MI: "/logos/mi.png",
  RCB: "/logos/rcb.png",
  KKR: "/logos/kkr.png",
  RR: "/logos/rr.png",
  DC: "/logos/dc.png",
  SRH: "/logos/srh.png",
  LSG: "/logos/lsg.png",
  GT: "/logos/gt.png",
  PBKS: "/logos/pbks.png",
  DEFAULT: "/logos/default.png",
};

const SOUND_START = "/sounds/start.mp3";
const SOUND_TICK = "/sounds/tick.mp3";
const SOUND_GOING_ONCE = "/sounds/going_once.mp3";
const SOUND_GOING_TWICE = "/sounds/going_twice.mp3";
const SOUND_SOLD = "/sounds/sold.mp3";
const SOUND_UNSOLD = "/sounds/unsold.mp3";

const MIN_USERS_TO_START = 2;

const formatPurse = (n) => (typeof n === "number" ? n.toFixed(2) : n ?? "--");
const formatBaseShort = (n) => {
  const num = parseFloat(n);
  if (Number.isNaN(num)) return "--";
  return num.toFixed(1);
};
const formatBid = (n) => (typeof n === "number" ? n.toFixed(2) : n ?? "--");
const isMobile = window.innerWidth < 768;
export default function App() {
  
  // core state
  const [socketId, setSocketId] = useState("");
  const [screen, setScreen] = useState("home"); // home | lobby | auction | finished
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [name, setName] = useState("");
  const [roomState, setRoomState] = useState(null); // server-sent sanitized room
  const [myTeam, setMyTeam] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [error, setError] = useState("");

  // right panel
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTeamId, setPanelTeamId] = useState(null);
  const [remainingPanelOpen,setRemainingPanelOpen] = useState(false);

  // audio refs
  const audioStart = useRef(null);
  const audioTick = useRef(null);
  const audioGoingOnce = useRef(null);
  const audioGoingTwice = useRef(null);
  const audioSold = useRef(null);
  const audioUnsold = useRef(null);

  // last timer seen (for detecting transitions)
  const lastTimerRef = useRef(null);

  useEffect(() => {
    // preload audio
    audioStart.current = new Audio(SOUND_START);
    audioTick.current = new Audio(SOUND_TICK);
    audioGoingOnce.current = new Audio(SOUND_GOING_ONCE);
    audioGoingTwice.current = new Audio(SOUND_GOING_TWICE);
    audioSold.current = new Audio(SOUND_SOLD);
    audioUnsold.current = new Audio(SOUND_UNSOLD);

    // socket handlers
    socket.on("connect", () => {
      setSocketId(socket.id);
      console.log("connected", socket.id);
    });

    // if server emits create-room-success
    socket.on("create-room-success", ({ code }) => {
      console.log("create-room-success", code);
      // host created the room; show lobby and save code
      setIsHost(true);
      setScreen("lobby");
      setRoomState((r) => (r ? { ...r, code } : { code }));
    });

    // joined ack (if server emits)
    socket.on("joined", ({ code }) => {
      console.log("joined:", code);
      setScreen("lobby");
    });

    socket.on("room-update", (sanitizedRoom) => {
      console.log("Room Update Arrived:", sanitizedRoom);
      // update roomState
     
      window.currentRoomState = sanitizedRoom;
       setRoomState(sanitizedRoom);
    });

    socket.on("error-message", (msg) => {
      setError(msg);
      setTimeout(() => setError(""), 4000);
    });

    // simple play events (server may send these)
    socket.on("play-start", () => audioStart.current?.play().catch(() => {}));
    socket.on("play-tick", () => audioTick.current?.play().catch(() => {}));
    socket.on("play-sold", () => audioSold.current?.play().catch(() => {}));
    socket.on("play-unsold", () => audioUnsold.current?.play().catch(() => {}));

    // cleanup
    return () => {
      socket.off("connect");
      socket.off("create-room-success");
      socket.off("joined");
      socket.off("room-update");
      socket.off("error-message");
      socket.off("play-start");
      socket.off("play-tick");
      socket.off("play-sold");
      socket.off("play-unsold");
    };
  }, []);

  // Auto-navigate to auction when server changes phase
  useEffect(() => {
    if (!roomState) return;
    if (roomState.phase === "bidding") {
      setScreen("auction");
    } else if (roomState.finished) {
      setScreen("finished");
    } else if (!roomState.started) {
      // if server says auction not started and client is in auction, go back to lobby
      if (screen === "auction") setScreen("lobby");
    }
  }, [roomState]);

  // Advanced sound logic based on timer transitions (client-side cues)
  useEffect(() => {
    if (!roomState) return;
    const t = roomState.timer ?? 0;
    const last = lastTimerRef.current;

    // tick on every update (optional)
    if (t !== last) {
      // play tick quietly for every second change if timer > 0
      if (t > 0) {
        audioTick.current?.play().catch(() => {});
      }
    }

    // going once at 10s
    if (last > 10 && t <= 10 && t > 5) {
      audioGoingOnce.current?.play().catch(() => {});
    }

    // going twice at 5s
    if (last > 5 && t <= 5 && t > 0) {
      audioGoingTwice.current?.play().catch(() => {});
    }

    lastTimerRef.current = t;
  }, [roomState?.timer]);

  // -------------------------
  // ACTIONS (no-ack emits)
  // -------------------------

  function createRoom() {
    if (!name || name.trim().length === 0) {
      setError("Enter your name first");
      return;
    }
    socket.emit("create-room", { name }); // server should emit create-room-success and room-update
    setIsHost(true);
    // we wait for server's room-update/create-room-success to populate roomState
    setScreen("lobby");
  }

  function joinRoom() {
    if (!name || name.trim().length === 0) {
      setError("Enter your name first");
      return;
    }
    if (!roomCodeInput || roomCodeInput.trim().length === 0) {
      setError("Enter a room code");
      return;
    }
    const code = roomCodeInput.trim().toUpperCase();
    socket.emit("join-room", { code, name }); // server should emit "joined" and "room-update"
    setIsHost(false);
    setScreen("lobby");
  }

  function selectTeam(teamId) {
    if (!roomState) return;
    setMyTeam(teamId);
    socket.emit("select-team", { code: roomState.code, teamId }); // no ack
  }

  function startAuction() {
    if (!roomState) {
      setError("Not connected to a room");
      return;
    }
    const usersCount = (roomState.users || []).length;
    if (usersCount < MIN_USERS_TO_START) {
      setError(`You need at least ${MIN_USERS_TO_START} players to start the auction`);
      return;
    }
    const participatingTeamIds = Array.from(
      new Set((roomState.users || []).map((u) => u.teamId).filter(Boolean))
    );
    if (participatingTeamIds.length < 2) {
      setError("At least 2 teams must be selected by users to start the auction");
      return;
    }

    socket.emit("start-auction", { code: roomState.code, participatingTeams: participatingTeamIds });
    // optionally immediately switch for host — server will broadcast room-update to everyone too
    setScreen("auction");
  }

  // Bid actions match your server's place-bid signature: { code, teamId, increment }
  function placeBaseBid() {
    if (!roomState) return setError("Not connected to a room");
    if (!myTeam) return setError("Select your team first");

    socket.emit("place-bid", { code: roomState.code, teamId: myTeam, increment: 0 });
    console.log("Base bid emitted");
  }

  function placeIncrement(inc) {
    if (!roomState) return setError("Not connected to a room");
    if (!myTeam) return setError("Select your team first");

    socket.emit("place-bid", { code: roomState.code, teamId: myTeam, increment: inc });
    console.log("Increment bid emitted", inc);
  }

  function useRTM() {
    if (!roomState) return setError("Not connected to a room");
    if (!myTeam) return setError("Select your team first");

    socket.emit("use-rtm", { code: roomState.code, teamId: myTeam });
    console.log("RTM emitted");
  }

  function skipPlayer() {
    if (!roomState) return setError("Not connected to a room");
    if (!isHost) return setError("Only host can skip a player");

    socket.emit("skip-player", { code: roomState.code });
    console.log("Skip emitted by host");
  }

  function endAuction() {
    if (!roomState) return setError("Not connected to a room");
    if (!isHost) return setError("Only host can end the auction");

    socket.emit("end-auction", { code: roomState.code });
    console.log("End auction emitted by host");
  }

  function leaveRoom() {
    if (!roomState) return;
    socket.emit("leave-room", { code: roomState.code });
    setRoomState(null);
    setScreen("home");
    setMyTeam("");
    setIsHost(false);
  }
  function downloadPDF() {
  const data = window.currentRoomState;

  console.log("DOWNLOAD PDF CLICKED. Data =", data);

  if (!data || !data.teams || Object.keys(data.teams).length === 0) {
    alert("PDF data not ready. Wait 1 second and try again.");
    return;
  }

  exportPDF(data);
}

  // panel controls
  function openTeamPanel(tid) {
    setPanelTeamId(tid);
    setPanelOpen(true);
  }
  function closeTeamPanel() {
    setPanelOpen(false);
    setTimeout(() => setPanelTeamId(null), 220);
  }

  // derived helpers
  const teamsObj = roomState?.teams || {};
  const takenTeams = new Set((roomState?.users || []).map((u) => u.teamId).filter(Boolean));

  // render screens
  function renderHome() {
    return (
      <div style={styles.centered}>
        <div style={styles.card}>
          <h1 style={{ margin: "0 0 12px 0" }}>IPL Mock Auction Mockroom</h1>

          <input
            placeholder="Enter your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={styles.input}
          />
          <input
              placeholder="Enter Room Code"
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value)}
              style={styles.input}
            />

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={createRoom} style={styles.greenBtn}>Create Room</button>
            <button onClick={joinRoom} style={styles.blueBtn}>Join Room</button>
          </div>

          {error && <div style={styles.error}>{error}</div>}
        </div>
      </div>
    );
  }

  function renderLobby() {
    return (
      <div style={styles.container}>
        <div style={{ ...styles.card, width: "65%" }}>
          <h2>Room: <span style={styles.code}>{roomState?.code || "—"}</span></h2>
          <div style={{ marginBottom: 8 }}>
            You: <strong>{name}</strong> {isHost && <span style={styles.tag}>Host</span>}
          </div>

          <div style={{ marginTop: 12 }}>
            <h3 style={{ margin: "8px 0" }}>Select your team</h3>
            <div style={styles.teamGrid}>
              {Object.keys(TEAM_LOGOS).filter(k => k !== "DEFAULT").map((tid) => {
                const taken = takenTeams.has(tid);
                const selected = myTeam === tid;
                return (
                  <button
                    key={tid}
                    disabled={taken && !selected}
                    onClick={() => selectTeam(tid)}
                    style={{
                      ...styles.teamBtn,
                      opacity: taken && !selected ? 0.5 : 1,
                      border: selected ? "2px solid #0f0" : "2px solid transparent",
                    }}
                  >
                    <img src={TEAM_LOGOS[tid] || TEAM_LOGOS.DEFAULT} alt={tid} style={{ width: 36, marginRight: 8 }} />
                    <span>{tid}{taken && !selected ? " (taken)" : ""}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 18 }}>
              <h3>Players in room</h3>
              <div style={styles.playersList}>
                {(roomState?.users || []).map((u) => (
                  <div key={u.socketId} style={styles.playerRow}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={styles.avatar}>{u.name?.[0]?.toUpperCase() || "?"}</div>
                      <div>
                        <div style={{ fontWeight: 700 }}>{u.name}</div>
                        <div style={{ fontSize: 12, color: "#aaa" }}>
                          {u.teamId ? (
                            <>
                              <img src={TEAM_LOGOS[u.teamId] || TEAM_LOGOS.DEFAULT} alt={u.teamId} style={{ width: 18, verticalAlign: "middle", marginRight: 6 }} />
                              {u.teamId}
                            </>
                          ) : "No team selected"}
                        </div>
                      </div>
                    </div>
                    <div>
                      {u.socketId === socketId && <span style={{ fontSize: 12, color: "#9f9" }}>You</span>}
                      {u.socketId === roomState?.ownerSocketId && <div style={styles.tag}>Owner</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              {isHost && <button onClick={startAuction} style={styles.greenBtn}>Start Auction</button>}
              <button onClick={leaveRoom} style={styles.grayBtn}>Leave</button>
            </div>

            {error && <div style={styles.error}>{error}</div>}
          </div>
        </div>

        <div style={{ width: "30%" }}>
          <div style={styles.card}>
            <h3>Room info</h3>
            <div>Code: <strong>{roomState?.code || "—"}</strong></div>
            <div>Users: {(roomState?.users || []).length}</div>

            <div style={{ marginTop: 10 }}>
              <h4>Teams selected</h4>
              <div>
                {Array.from(new Set((roomState?.users || []).map(u => u.teamId).filter(Boolean))).map(tid => (
                  <div key={tid} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <img src={TEAM_LOGOS[tid] || TEAM_LOGOS.DEFAULT} alt={tid} style={{ width: 20 }} />
                    <div>{tid}</div>
                  </div>
                ))}
                {(!roomState?.users || roomState.users.length === 0) && <div>No players</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

 function renderAuction() {
  if (!roomState) return null;

  const currentPlayer = roomState.currentPlayer;
  const currentBid = roomState.currentBid;
  const bidTeam = roomState.currentBidTeamId;

  return (
    <div style={styles.container}>
      <div style={styles.cardLarge}>

        {/* MAIN TOP SECTION */}
        <div style={{ display: "flex", justifyContent: "space-between" }}>

          {/* LEFT SIDE - CURRENT PLAYER INFO */}
          <div style={{ width: "63%" }}>

            {/* PLAYER HEADER */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img
                src={TEAM_LOGOS[currentPlayer?.PrevTeam] || TEAM_LOGOS.DEFAULT}
                alt=""
                style={{ width: 64 }}
              />

              <div>
                <div style={{ fontSize: 28, fontWeight: 800 }}>
                  {currentPlayer?.Name || "—"}
                </div>

                <div style={{ color: "#ddd" }}>
                  {currentPlayer?.Role} • Base: ₹{currentPlayer?.Base || 0} Cr • {currentPlayer?.Country}
                </div>

                <div style={{ marginTop: 6, color: "#7af" }}>
                  Set: {currentPlayer?.Set || "Unknown"}
                </div>
              </div>
            </div>

            {/* CURRENT BID */}
            <div style={{ marginTop: 18 }}>
              <div style={{ color: "#9fb" }}>Current bid:</div>

              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {currentBid !== null ?` ${currentBid} Cr `: "No bid yet"}
              </div>

              <div style={{ marginTop: 8, color: "#cbd5f5" }}>
                By: {bidTeam ? (
                  <>
                    <img
                      src={TEAM_LOGOS[bidTeam] || TEAM_LOGOS.DEFAULT}
                      alt=""
                      style={{ width: 18, marginRight: 6 }}
                    />
                    {bidTeam}
                  </>
                ) : "—"}
              </div>
            </div>

            {/* TIMER */}
            <div style={{ marginTop: 18 }}>
              <div style={{ color: "#9fb" }}>Time left:</div>

              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {(roomState.timer || 0) + "s"}
              </div>

              <div style={{ height: 8, background: "#222", marginTop: 8, borderRadius: 6 }}>
                <div
                  style={{
                    height: "100%",
                    width:` ${((roomState.timer ?? 0) / (roomState.timerMax ?? 10)) * 100}%`,
                    background: "#1ecf5b",
                    borderRadius: 6
                  }}
                />
              </div>
            </div>

            {/* BIDDING BUTTONS */}
            <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>

              <button
                onClick={placeBaseBid}
                disabled={currentBid !== null}
                style={styles.greenBtn}
              >
                Bid @ Base ({currentPlayer?.Base})
              </button>

              <button onClick={() => placeIncrement(0.2)} style={styles.greenBtn}>
                +20 Lakhs
              </button>

              <button onClick={() => placeIncrement(0.5)} style={styles.blueBtn}>
                +50 Lakhs
              </button>

              <button onClick={() => placeIncrement(1)} style={styles.redBtn}>
                +1 Cr
              </button>

              <button onClick={useRTM} style={styles.orangeBtn}>
                Use RTM
              </button>

              {isHost && (
                <>
                  <button onClick={skipPlayer} style={styles.grayBtn}>Skip Player</button>
                  <button onClick={endAuction} style={styles.grayBtn}>End Auction</button>
                </>
              )}
            </div>

            {error && <div style={styles.error}>{error}</div>}
          </div>

          {/* RIGHT SIDE */}
          <div style={{ width: "33%" }}>

            {/* SOLD LIST */}
            <div style={styles.card}>
              <h4>Sold</h4>
              {(roomState.sold || []).map((s, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700 }}>{s.player.Name}</div>
                  <div style={{ color: "#9fb" }}>
                    {s.teamId} — ₹{s.amount} Cr
                  </div>
                </div>
              ))}
            </div>

            <div style={{ height: 12 }} />

            {/* REMAINING PLAYERS BUTTON */}
            <button
              onClick={() => setRemainingPanelOpen(true)}
              style={{
                background: "#21b8ff",
                border: 0,
                padding: "10px 14px",
                width: "100%",
                borderRadius: 10,
                cursor: "pointer",
                fontWeight: 700,
                marginBottom: 12
              }}
            >
              Remaining Players
            </button>
            <div style={{
  marginTop: 12,
  textAlign: "center",
  color: "#7af",
  fontWeight: 700
}}>
  Remaining Players: {roomState.remainingPlayers?.length ?? 0}
</div>

            <div style={{ height: 12 }} />

            {/* TEAMS */}
            <div style={styles.card}>
              <h4>Teams & Purses</h4>

              {Object.entries(roomState.teams || {}).map(([tid, t]) => (
                <div
                  key={tid}
                  onClick={() => openTeamPanel(tid)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px",
                    marginBottom: 8,
                    background: "#111",
                    borderRadius: 6,
                    cursor: "pointer"
                  }}
                >
                  <img
                    src={TEAM_LOGOS[tid] || TEAM_LOGOS.DEFAULT}
                    alt={tid}
                    style={{ width: 28, height: 28 }}
                  />

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{tid}</div>
                    <div style={{ fontSize: 12, color: "#bbb" }}>
                      ₹{Number(t.purse).toFixed(2)} Cr
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: "#9bd" }}>
                    RTM: {t.rtmLeft ?? 0}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

 function evaluateTeam(team) {
  // team: { purse, rtmLeft, players: [ { Name, Role, amount, Base, Country } ] }
  const players = team.players || [];

  // Basic role counts
  const counts = { Batsman: 0, Bowler: 0, Allrounder: 0, WK: 0, Other: 0 };
  for (const p of players) {
    const r = (p.Role || "").toLowerCase();
    if (r.includes("bat")) counts.Batsman++;
    else if (r.includes("bowl")) counts.Bowler++;
    else if (r.includes("all")) counts.Allrounder++;
    else if (r.includes("wk") || r.includes("wicket")) counts.WK++;
    else counts.Other++;
  }

  // Money-based signals
  const totalSpent = players.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const avgSpend = players.length ? totalSpent / players.length : 0;

  // Foreign player count
  const foreignCount = players.filter(p => {
    const c = (p.Country || "").toLowerCase();
    return c && c !== "india" && c !== "in";
  }).length;

  // Heuristic rating: balance + depth + value
  // Start score 5, add/subtract up to ±4 then clamp to 1..10
  let score = 5;

  // batting depth
  if (counts.Batsman >= 5) score += 1;
  if (counts.Batsman >= 7) score += 1;

  // bowling depth
  if (counts.Bowler >= 4) score += 1;
  if (counts.Bowler >= 6) score += 1;

  // allrounders are valuable
  if (counts.Allrounder >= 2) score += 1;
  if (counts.Allrounder === 0) score -= 1;

  // wicketkeeper presence
  if (counts.WK >= 1) score += 0.5;

  // average spend implies star players
  if (avgSpend >= 5) score += 1;         // many high-priced players
  else if (avgSpend >= 2) score += 0.5;

  // too many foreigners reduces balance (league limit)
  if (foreignCount > 4) score -= 1;

  // small adjustment for purse remaining (more remaining = more flexibility)
  
  const purseLeft = Number(team.purse || 0);
  if (purseLeft >= 20) score += 0.5;
  if (purseLeft < 5) score -= 0.5;

  // clamp and convert to 1-10 integer
  score = Math.max(1, Math.min(10, Math.round(score)));

  // Strengths & weaknesses descriptions (simple sentences)
  const strengths = [];
  const weaknesses = [];

  if (counts.Batsman >= 6) strengths.push("Deep opening/top-order batting");
  if (counts.Batsman >= 4 && counts.Allrounder >= 1) strengths.push("Balanced batting core with power hitters");
  if (counts.Bowler >= 5) strengths.push("Strong bowling attack with multiple options");
  if (counts.Allrounder >= 2) strengths.push("Good bowling-batting balance via all-rounders");
  if (avgSpend >= 4) strengths.push("Has one or more high-quality marquee players");

  if (counts.Allrounder === 0) weaknesses.push("Lacks quality all-rounders");
  if (counts.Bowler < 3) weaknesses.push("Thin bowling resources");
  if (counts.Batsman < 3) weaknesses.push("Fragile batting depth");
  if (foreignCount > 4) weaknesses.push("Potential foreign player limit / balance issues");
  if (purseLeft < 5) weaknesses.push("Limited purse remaining for last-stage buys");

  // MVP: choose the player with highest amount; fallback to highest Base then first player
  let mvp = null;
  if (players.length) {
    mvp = [...players].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0];
    if (!mvp) mvp = players[0];
  }

  return {
    rating: score,
    strengths,
    weaknesses,
    mvp
  };
}

// ================================
// ⭐ EXPORT PDF FUNCTION (INSIDE APP COMPONENT)
// ================================
function fixSpacing(text) {
  return text.replace(/\s+/g, " ").trim();  // replaces multiple spaces with one
}
async function exportPDF(room) {
  if (!room) return;

  console.log("ExportPDF called with room =", room);

  const teams = room.teams || {};
  const summary = {};

  // ----- Build team summaries -----
  for (const [tid, t] of Object.entries(teams)) {
    const playersRaw = (t.players || []).map((p) => ({
      Name: p.Name || p.name || "Unknown",
      Role: p.Role || p.role || "Unknown",
      amount: Number(p.amount) || 0,
      Base: Number(p.base || p.Base) || 0,
      country: p.Country || p.country || "Unknown",
    }));

    const teamData = {
      purse: Number(t.purse || 0),
      rtmLeft: Number(t.rtmLeft || 0),
      players: playersRaw,
    };

    const evalResult = evaluateTeam(teamData);

    summary[tid] = {
      ...teamData,
      rating: evalResult.rating,
      strengths: evalResult.strengths,
      weaknesses: evalResult.weaknesses,
      mvp: evalResult.mvp,
    };
  }

  // Sort teams by rating
  const sortedTeams = Object.entries(summary).sort(([, a], [, b]) => b.rating - a.rating);

  // ----- Create PDF -----
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(20)

  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 40;
  const marginLeft = 40;
  const usableWidth = pageWidth - marginLeft * 2;

  // ------------------ TITLE -------------------------
  doc.setFontSize(24);
  doc.text("IPL Auction Summary", pageWidth / 2, y, { align: "center" });
  y += 40;

  // ------------------ TEAMS LOOP ---------------------
  for (const [tid, t] of sortedTeams) {
    if (y > 720) { doc.addPage(); y = 40; }

    // ---- TEAM HEADER WITH LOGO ----
    doc.setFillColor(240);
    doc.rect(40, y, pageWidth - 80, 50, "F");

    // Team logo
    try {
      const logo = LOGOS[tid];
      if (logo) {
        doc.addImage(logo, "PNG", 50, y + 5, 40, 40);
      }
    } catch (e) {}

    doc.setFontSize(18);
    doc.setFont(undefined, "bold");
    doc.text(tid, 100, y + 30);

    y += 70;

    // ----- TEAM INFO -----
    doc.setFontSize(12);
    doc.setFont(undefined, "normal");

    doc.text(`Purse Remaining: ${t.purse.toFixed(2)} Cr`, 50, y);
    doc.text(`RTM Left: ${t.rtmLeft}`, pageWidth - 180, y);
    y += 20;

    doc.text(`Rating: ${t.rating}/10`, 50, y);
    y += 18;

    // Strengths
    doc.setFont(undefined, "bold");
    doc.text("Strengths:", 50, y);
    doc.setFont(undefined, "normal");
    doc.text(t.strengths.length ? t.strengths.join(", ") : "—", 130, y);
    y += 16;

    // Weaknesses
    doc.setFont(undefined, "bold");
    doc.text("Weaknesses:", 50, y);
    doc.setFont(undefined, "normal");
    doc.text(t.weaknesses.length ? t.weaknesses.join(", ") : "—", 140, y);
    y += 20;

    // MVP
    if (t.mvp) {
      doc.setFont(undefined, "bold");
      doc.text("MVP:", 50, y);
      doc.setFont(undefined, "normal");

      const mvptxt = `${t.mvp.Name} (${t.mvp.Role}) —  ${(t.mvp.amount || 0).toFixed(2)} Cr`;
      doc.text(mvptxt, 100, y);
      y += 22;
    }
    // ------------------- SQUAD SECTION -------------------
doc.setFontSize(14);
doc.text("Squad Summary", marginLeft, y);
y += 12;
doc.setDrawColor(180);
doc.line(marginLeft, y, pageWidth - marginLeft, y);
y += 14;

// GROUP PLAYERS BY ROLE
const squadGroups = {
    Batsmen: [],
    Allrounders: [],
    Bowlers: [],
    Wicketkeepers: []
};

for (const p of t.players) {
    const role = (p.Role || "").toLowerCase();

    if (role.includes("bat")) squadGroups.Batsmen.push(p);
    else if (role.includes("all")) squadGroups.Allrounders.push(p);
    else if (role.includes("bowl")) squadGroups.Bowlers.push(p);
    else if (role.includes("keeper") || role.includes("wk")) squadGroups.Wicketkeepers.push(p);
    else squadGroups.Batsmen.push(p); // fallback
}

function printGroup(title, arr) {
    if (arr.length === 0) return;

    doc.setFontSize(12);
    doc.setFont("Helvetica", "bold");
    doc.text(`${title} (${arr.length})`, marginLeft, y);
    y += 12;
    doc.setFont("Helvetica", "normal");

    for (const p of arr) {
        if (y > 760) { // page break
            doc.addPage();
            y = 40;
        }

        const price = Number(p.amount || p.Base || 0).toFixed(2);
        const text = `${p.Name} - ${p.Role} - ${price} Cr`;

        doc.text(text, marginLeft + 10, y);
        y += 12;
    }

    y += 6; // space between sections
}

// PRINT ALL GROUPS
printGroup("Batsmen", squadGroups.Batsmen);
printGroup("Allrounders", squadGroups.Allrounders);
printGroup("Bowlers", squadGroups.Bowlers);
printGroup("Wicketkeepers", squadGroups.Wicketkeepers);

    // Divider
    doc.setDrawColor(180);
    doc.line(40, y, pageWidth - 40, y);
    y += 20;

    // ---------------- Players List ----------------
   
  }

  // ---------- TOP 3 TEAMS ----------
  doc.addPage();
  y = 60;

  doc.setFontSize(20);
  doc.setFont(undefined, "bold");
  doc.text("Top 3 Teams (by Rating)", pageWidth / 2, y, { align: "center" });
  y += 30;

  doc.setFontSize(14);
  doc.setFont(undefined, "normal");

  sortedTeams.slice(0, 3).forEach(([tid, t], i) => {
    doc.text(`${i + 1}. ${tid} — Rating: ${t.rating}/10`, 80, y);
    y += 20;
  });

  // Save file
  doc.save("auction_summary.pdf");
}
// ================================
// ⭐ FINAL RENDER FINISHED FUNCTION
// ================================
function renderFinished() {
  if (!roomState) return null;

  const teams = roomState.teams || {};
  const sold = roomState.sold || [];

  return (
    <div style={styles.centered}>
      <div style={{ ...styles.card, width: 750 }}>
        <h1>Auction Summary</h1>

        {/* TEAM SUMMARY */}
        {Object.entries(teams).map(([tid, t]) => {
          const players = sold.filter(s => s.teamId === tid).map(s => s.player.Name);

          return (
            <div key={tid} style={{ marginBottom: 25 }}>
              <h2 style={{ color: "#7af" }}>
                <img
                  src={TEAM_LOGOS[tid] || TEAM_LOGOS.DEFAULT}
                  alt=""
                  style={{ width: 30, marginRight: 10, verticalAlign: "middle" }}
                />
                {tid}
              </h2>

              <strong>Purse Left:</strong> ₹{t.purse.toFixed(2)} Cr
              <br />
              <strong>Players Bought:</strong> {players.length}

              <ul>
                {players.map((p, idx) => (
                  <li key={idx}>{p}</li>
                ))}
              </ul>

              <strong>MVP:</strong> {players[0] || " "} <br />
              <strong>Best Value Pick:</strong> {players[players.length - 1] || " "} <br />
            
            </div>
          );
        })}

        {/* DOWNLOAD BUTTON */}
        <button onClick={downloadPDF} style={styles.greenBtn}>
          Download PDF Summary
        </button>
      </div>
    </div>
  );
}
function renderTeamPanel() {
  if (!panelOpen || !panelTeamId || !roomState) return null;

  const team = roomState.teams?.[panelTeamId];
  if (!team) return null;

  const spent = (team.players || []).reduce(
    (sum, p) => sum + Number(p.amount || p.price || 0),
    0
  );

  return (
    <div style={{
      position: "fixed",
      top: 0,
      right: 0,
      width: 360,
      height: "100vh",
      background: "#0c0c0c",
      padding: 18,
      color: "#fff",
      overflowY: "auto",
      zIndex: 9999,
      boxShadow: "-8px 0 18px rgba(0,0,0,0.6)"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>{panelTeamId}</h2>
        <button onClick={closeTeamPanel} style={styles.grayBtn}>X</button>
      </div>

      <h3>Purse Spent: ₹{spent.toFixed(2)} Cr</h3>
      <h3>Purse Remaining: ₹{Number(team.purse).toFixed(2)} Cr</h3>

      <h3>Players Bought ({team.players.length})</h3>

      {team.players.map((p, i) => (
        <div key={i} style={{ marginBottom: 10, borderBottom: "1px solid #222", paddingBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>{p.Name}</div>
          <div style={{ fontSize: 12, color: "#bbb" }}>{p.Role}</div>
          <div>₹{Number(p.amount).toFixed(2)} Cr</div>
        </div>
      ))}
    </div>
  );
}

function renderRemainingPanel() {
  if (!remainingPanelOpen || !roomState) return null;

  const grouped = {};
  (roomState.remainingPlayers || []).forEach((p) => {
    const setName = p.Set || "Unknown";
    if (!grouped[setName]) grouped[setName] = [];
    grouped[setName].push(p);
  });

  return (
    <div style={{
      position: "fixed",
      top: 0,
      right: 0,
      width: 360,
      height: "100vh",
      background: "#0b1720",
      padding: 18,
      color: "#fff",
      overflowY: "auto",
      zIndex: 99999,
      boxShadow: "-8px 0 18px rgba(0,0,0,0.6)"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Remaining Players</h2>
        <button onClick={() => setRemainingPanelOpen(false)} style={styles.grayBtn}>X</button>
      </div>

      {Object.entries(grouped).map(([setName, players]) => (
        <div key={setName} style={{ marginTop: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#7af" }}>
            {setName}
          </div>

          {players.map((p, i) => (
            <div key={i} style={{ marginLeft: 12, marginTop: 6 }}>
              • {p.Name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

  // main render
  return (
    <div style={styles.app}>
      {screen === "home" && renderHome()}
      {screen === "lobby" && renderLobby()}
      {screen === "auction" && renderAuction()}
      {screen === "finished" && renderFinished()}


    {panelOpen && panelTeamId && (
  <div
    style={{
      position: "fixed",
      top: 0,
      right: 0,
      width: 360,
      height: "100vh",
      background: "#0c0c0c",
      padding: 18,
      color: "#fff",
      overflowY: "auto",
      zIndex: 9999,
      boxShadow: "-8px 0 18px rgba(0,0,0,0.6)"
    }}
  >
    {/* HEADER */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img
          src={TEAM_LOGOS[panelTeamId] || TEAM_LOGOS.DEFAULT}
          alt={panelTeamId}
          style={{ width: 50, height: 50 }}
        />
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{panelTeamId}</div>
        </div>
      </div>

      <button
        onClick={closeTeamPanel}
        style={{
          background: "#222",
          border: "1px solid #555",
          color: "#fff",
          padding: "5px 10px",
          cursor: "pointer",
          borderRadius: 6
        }}
      >
        X
      </button>
    </div>

    <div style={{ height: 14 }} />

    {/* TEAM DETAILS */}
    {(() => {
      const team = roomState?.teams?.[panelTeamId];
      if (!team) return <div>Loading...</div>;

      const spent = (team.players || []).reduce(
        (sum, p) => sum + Number(p.amount || p.price || 0),
        0
      );

      return (
        <div>
          <div style={{ fontSize: 14, marginBottom: 4 }}>Purse Spent</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>
            ₹{spent.toFixed(2)} Cr
          </div>

          <div style={{ height: 12 }} />

          <div style={{ fontSize: 14, marginBottom: 4 }}>Purse Remaining</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>
            ₹{Number(team.purse).toFixed(2)} Cr
          </div>

          <hr style={{ margin: "18px 0", borderColor: "#222" }} />

          <div style={{ fontSize: 16, fontWeight: 700 }}>
            Players Bought ({team.players.length})
          </div>

          <ul style={{ marginTop: 10, paddingLeft: 0, listStyle: "none" }}>
            {team.players.map((p, i) => (
              <li
                key={i}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid #111",
                  display: "flex",
                  justifyContent: "space-between"
                }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>{p.Name}</div>
                  <div style={{ fontSize: 12, color: "#bbb" }}>{p.Role}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 800 }}>
                    ₹{Number(p.amount).toFixed(2)} Cr
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )
    })()}
  </div>
)}
{remainingPanelOpen && (
  <div
    style={{
      position: "fixed",
      top: 0,
      right: 0,
      width: 360,
      height: "100vh",
      background: "#0b1720",
      padding: 18,
      color: "#fff",
      overflowY: "auto",
      zIndex: 99999,
      boxShadow: "-8px 0 18px rgba(0,0,0,0.6)"
    }}
  >
    {/* HEADER */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <h2>Remaining Players</h2>
      <button
        onClick={() => setRemainingPanelOpen(false)}
        style={styles.grayBtn}
      >
        X
      </button>
    </div>

    {/* GROUP PLAYERS BY SET */}
    {Object.entries(
      (roomState.remainingPlayers || []).reduce((acc, p) => {
        const setName = p.Set || "Unknown";
        if (!acc[setName]) acc[setName] = [];
        acc[setName].push(p);
        return acc;
      }, {})
    ).map(([setName, players]) => (
      <div key={setName} style={{ marginTop: 18 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#7af" }}>
          {setName}
        </div>

        {players.map((p, i) => (
          <div key={i} style={{ marginLeft: 12, marginTop: 6 }}>
            • {p.Name}
          </div>
        ))}
      </div>
    ))}
  </div>
)}
 {/* floating error */}
      {error && <div style={styles.toast}>{error}</div>}
    </div>
  )
}

// styles
const styles = {
  app: { minHeight: "100vh", background: "linear-gradient(180deg,#072339,#041826)", padding: "12px",width: "100%", maxWidth: "100%", overflowX: "hidden" , color: "#fff", fontFamily: "Inter, system-ui, sans-serif" },
  centered: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "80vh" },
  page: {minHeight: "100vh", width: "100%", display: "flex", justifyContent: "center",alignItems: "flex-start", padding: "16px", boxSizing: "border-box"},
  card: { width: "100%", maxWidth: "100%",minHeight: "100vh", background: "#0b1720", padding: 16, borderRadius: 0,display: "flex", flexDirection: "column", boxShadow: "0 8px 30px rgba(0,0,0,0.6)" },
  cardLarge: { background: "#0b1720", padding: 18, borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.6)", width: "100%" },
  container: { maxWidth: 420, margin: "0 auto" , padding: "16px" , display: "flex",flexDirection: "column", gap: 18 },
  input: { width: "100%",padding: "12px 14px",marginBottom: 12, borderRadius: 8, border: "1px solid #223",fontSize: 16, background: "#07111a", color: "#fff", width: 260 },
  greenBtn: {
      flex: 1,
      background: "#1ecf5b",
      border: 0,
      padding: isMobile ? "12px 10px" : "10px 14px",
      borderRadius: 20,
      cursor: "pointer",
      width: isMobile ? "100%" : "auto",
      fontWeight: 700,
      color:"#fff"
    },
  blueBtn: {
      flex: 1,
      background: "#21b8ff",
      border: 0,
      padding: isMobile ? "12px 10px" : "10px 14px",
      borderRadius: 20,
      cursor: "pointer",
      width: isMobile ? "100%" : "auto",
      fontWeight: 700,
      color:"#fff" 
    },
  redBtn: {
      background: "#ff5b5b",
      border: 0,
      padding: isMobile ? "12px 10px" : "10px 14px",
      borderRadius: 20,
      cursor: "pointer",
      width: isMobile ? "100%" : "auto",
      fontWeight: 700,
      color:"#fff" 
    },
  orangeBtn: {
      background: "#f5a623",
      border: 0,
      padding: isMobile ? "12px 10px" : "10px 14px",
      borderRadius: 20,
      cursor: "pointer",
      width: isMobile ? "100%" : "auto",
      fontWeight: 700,
      color:"#fff" 
    },
  grayBtn: {
      background: "#666",
      border: 0,
      padding: isMobile ? "12px 10px" : "10px 14px",
      borderRadius: 20,
      cursor: "pointer",
      width: isMobile ? "100%" : "auto",
      fontWeight: 700,
      color:"#fff"
    },
  teamGrid: { display: "flex", flexWrap: "wrap",justifyContent: "center", gap: 12,width: "100%" },
  teamBtn: {
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      justifyContent: "center",
      alignItems: "center",
      padding: isMobile ? 8 : 10,
      minWidth: isMobile ? "45%" : 110,
      width: isMobile ? "45%" : "auto",
      borderRadius: 8,
      background: "#07202b",
      color: "#fff",
      cursor: "pointer",
      textAlign: "center",
    },
  playersList: { marginTop: 8, display: "flex",flexWrap: "wrap",justifyContent: "center", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" },
  playerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "#07121a" },
  avatar: { width: 36, height: 36, borderRadius: 8, background: "#08202a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 },
  tag: { background: "#0f0", color: "#012", padding: "4px 8px", borderRadius: 6, fontSize: 12 },
  code: { background: "#0b3", padding: "4px 8px", borderRadius: 6, color: "#012", fontWeight: 800 },
  error: { marginTop: 12, color: "salmon" },
  toast: { position: "fixed", bottom: 20, left: 20, background: "#222", color: "#fff", padding: 12, borderRadius: 8 }
};
