// ── ICP Profile ──────────────────────────────────────────────

export type ICPProfile = {
  demographics: {
    role: string;
    seniority: string;
    companySize: string;
    industry: string[];
    geography: string[];
  };
  psychographics: {
    fears: string[];
    desires: string[];
    worldview: string;
    identityStatements: string[]; // "I am the kind of person who..."
  };
  buyingBehavior: {
    triggers: string[];        // what makes them start looking
    objections: string[];      // what holds them back
    decisionProcess: string;   // how they evaluate
    budget: string;
  };
  languagePatterns: {
    problemLanguage: string[]; // how they describe their pain
    solutionLanguage: string[]; // how they describe what they want
    phrases: string[];          // exact phrases they use
  };
  whereTheyGather: {
    platforms: string[];
    communities: string[];
    publications: string[];
    events: string[];
  };
  summary: string; // one-paragraph ICP statement
};

// ── Keyword Map ──────────────────────────────────────────────

export type KeywordCluster = {
  theme: string;
  keywords: Keyword[];
};

export type Keyword = {
  term: string;
  intent: "awareness" | "consideration" | "decision";
  source: "problem-language" | "solution-language" | "category" | "long-tail";
  notes: string;
};

export type KeywordMap = {
  awareness: KeywordCluster[];
  consideration: KeywordCluster[];
  decision: KeywordCluster[];
  summary: string;
};

// ── Intake ───────────────────────────────────────────────────

export type IntakeData = {
  businessName: string;
  whatTheyDo: string;
  currentAudience: string;
  problemSolved: string;
  positioningAspiration: string;
  existingData: string;
  additionalContext: string;
};

// ── Workflow State ───────────────────────────────────────────

export type Phase =
  | "intake"
  | "icp-research"
  | "icp-review"
  | "keyword-research"
  | "keyword-review"
  | "deliver"
  | "complete";

export type WorkflowState = {
  phase: Phase;
  intake: IntakeData | null;
  icpDraft: ICPProfile | null;
  icpApproved: boolean;
  icpFeedbackHistory: string[];
  keywordMap: KeywordMap | null;
  keywordsApproved: boolean;
  keywordFeedbackHistory: string[];
};

export function createInitialState(): WorkflowState {
  return {
    phase: "intake",
    intake: null,
    icpDraft: null,
    icpApproved: false,
    icpFeedbackHistory: [],
    keywordMap: null,
    keywordsApproved: false,
    keywordFeedbackHistory: [],
  };
}
