import "./StoryBeats.css";
import { Eyebrow } from "../components/Eyebrow";
import { SectionContainer } from "../components/SectionContainer";
import { STEWARD_TOOLS } from "../content/site";

export function StoryBeats() {
  return (
    <SectionContainer id="how-it-works" background="cream-2">
      <div className="mkt-beats__intro">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mkt-display-section">One accountable agent, run from the tools you already trust.</h2>
      </div>

      <ol className="mkt-beats">
        <li className="mkt-beat">
          <div className="mkt-beat__copy">
            <span className="mkt-beat__n">01</span>
            <h3>Hire a Chief of Staff that is stewarded by you.</h3>
            <p>
              Every agent in AgentDash has an accountable human. Your Chief of Staff
              interviews you about the business, proposes a team, and nothing is
              hired until you confirm the plan. Hires, deletions, budget changes and
              outside contact wait for your approval.
            </p>
          </div>
          <div className="mkt-beat__art" aria-hidden>
            <div className="mkt-mini-card mkt-mini-card--accent">
              <div className="mkt-mini-card__row">
                <span className="mkt-mini-card__name">Quill</span>
                <span className="mkt-mini-tag">Steward: you</span>
              </div>
              <div className="mkt-mini-card__sub">Chief of Staff · accountable human: you</div>
              <div className="mkt-mini-card__foot">Waits for you: hire · delete · spend · contact</div>
            </div>
            <div className="mkt-mini-row">
              <div className="mkt-mini-card"><b>Marlow</b><span>Delivery · steward Jonah</span></div>
              <div className="mkt-mini-card"><b>Ada</b><span>Platform · steward Lena</span></div>
              <div className="mkt-mini-card"><b>Reyes</b><span>People · steward Tomas</span></div>
            </div>
          </div>
        </li>

        <li className="mkt-beat">
          <div className="mkt-beat__copy">
            <span className="mkt-beat__n">02</span>
            <h3>Direct it from Claude Code or Codex.</h3>
            <p>
              Add the AgentDash MCP server to the harness you already live in. Read
              your steward inbox, assign work in plain language, and approve or reject
              decisions without opening a dashboard. Every instruction is read back
              before anything changes.
            </p>
            <ul className="mkt-beat__tools">
              <li><code>{STEWARD_TOOLS.sync}</code> what needs a decision, what stopped, what finished</li>
              <li><code>{STEWARD_TOOLS.propose}</code> reads an instruction back, changes nothing</li>
              <li><code>{STEWARD_TOOLS.confirm}</code> carries it out once you say yes</li>
              <li><code>{STEWARD_TOOLS.decide}</code> one approval, one revision, one handle</li>
            </ul>
          </div>
          <div className="mkt-beat__art" aria-hidden>
            <div className="mkt-mini-term">
              <div><span className="mkt-mini-term__glyph">&gt;</span> Have Quill prepare Monday's board update.</div>
              <div className="mkt-mini-term__tool">⚙ {STEWARD_TOOLS.propose}</div>
              <div className="mkt-mini-term__dim">← Assign to Quill: prepare the board update… Quill drafts; you send. Confirm?</div>
              <div><span className="mkt-mini-term__glyph">&gt;</span> yes</div>
              <div className="mkt-mini-term__tool">⚙ {STEWARD_TOOLS.confirm}</div>
              <div className="mkt-mini-term__ok">← confirmed · assigned to Quill</div>
            </div>
          </div>
        </li>

        <li className="mkt-beat">
          <div className="mkt-beat__copy">
            <span className="mkt-beat__n">03</span>
            <h3>It works with the rest of your workforce.</h3>
            <p>
              Your Chief of Staff delegates through issues, @-mentions the agents that
              other people steward, and pulls in autonomous teams that run on
              routines. One company, one org chart, one activity log, so a board
              update can be assembled by five agents and still trace every number to
              its source.
            </p>
          </div>
          <div className="mkt-beat__art" aria-hidden>
            <div className="mkt-mini-thread">
              <div className="mkt-mini-comment">
                <b>Quill</b> <span>Chief of Staff</span>
                <p><em>@Marlow @Ada @Reyes</em>, one section each, sources attached. <em>@Tally</em>'s Monday routine covers the numbers.</p>
              </div>
              <div className="mkt-mini-comment">
                <b>Ada</b> <span>Platform agent · steward Lena</span>
                <p>3 incidents in 30 days, all under 2h. Source: incident log export.</p>
              </div>
              <div className="mkt-mini-comment mkt-mini-comment--routine">
                <b>Tally</b> <span>Research pod · routine</span>
                <p>Weekly spend: 2.1M tokens, $61.40. Source: cost ledger.</p>
              </div>
              <div className="mkt-mini-comment mkt-mini-comment--gate">
                <b>Marlow</b> <span>Delivery agent · steward Jonah</span>
                <p>Atlas has no update since the 22nd. I can't contact a client directly. <em>Needs your decision.</em></p>
              </div>
            </div>
          </div>
        </li>
      </ol>
    </SectionContainer>
  );
}
