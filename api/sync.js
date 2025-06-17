import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

// Canvas API Config
const canvasConfigs = [
  {
    token: process.env.CANVAS_1_API_TOKEN,
    baseUrl: process.env.CANVAS_1_API_BASE,
    label: process.env.CANVAS_1_LABEL,
  },
  {
    token: process.env.CANVAS_2_API_TOKEN,
    baseUrl: process.env.CANVAS_2_API_BASE,
    label: process.env.CANVAS_2_LABEL,
  },
].filter((c) => c.token && c.baseUrl);

function detectSubmissionStatus(assignment, currentLabel) {
  const submission = assignment?.submission;
  const hasGrade = submission?.score != null;
  const isLate = submission?.late;
  const isSubmitted = submission?.submitted_at;
  const isMissing = submission?.missing;
  const dueAt = assignment?.due_at;
  const now = new Date().toISOString();

  if (
    currentLabel === "💀 Never Gave" &&
    !isSubmitted &&
    !hasGrade &&
    dueAt &&
    now > dueAt
  ) return currentLabel;

  if (isSubmitted) return "✨ Dominated";
  if (isLate || isMissing) return "⏰ Delayed AF";
  if (!submission) return "🧠 Manifesting Productivity";
  return currentLabel || "🧠 Manifesting Productivity";
}

function buildGradeString(submission, assignment) {
  if (!submission || submission.score == null || assignment.points_possible == null) {
    return "Not Graded";
  }
  return `${submission.score} / ${assignment.points_possible}`;
}

function detectClosedStatus(assignment) {
  return assignment?.closed_for_submissions ? "Yes" : "No";
}

async function fetchAllPages(url, token) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
