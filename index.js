const express = require("express");
const { Client } = require("@notionhq/client");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const cheerio = require("cheerio");
require("dotenv").config();

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const NOTION_DB_ID = process.env.NOTION_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

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
].filter(c => c.token && c.baseUrl);

// 🔍 Find Notion course page by Canvas Course Name
async function findCoursePageId(canvasCourseName) {
  const res = await notion.databases.query({
    database_id: COURSE_PLANNER_DB,
    filter: {
      property: "Canvas Course Name",
      rich_text: {
        equals: canvasCourseName,
      },
    },
  });

  return res.results.length ? res.results[0].id : null;
}

// 🎯 Assignment Type detector
function detectTypeFromName(name) {
  const lowered = name.toLowerCase();
  if (lowered.includes("quiz")) return "Quiz";
  if (lowered.includes("exam") || lowered.includes("test")) return "Exam";
  if (lowered.includes("discussion")) return "Discussion";
  if (lowered.includes("lecture")) return "Lecture";
  if (lowered.includes("extra credit")) return "Extra Credit";
  if (lowered.includes("reading")) return "Reading";
  if (lowered.includes("animation")) return "Animation";
  if (lowered.includes("chatgpt")) return "ChatGPT";
  if (lowered.includes("worksheet")) return "Worksheet";
  if (lowered.includes("homework") || lowered.includes("assignment")) return "Homework";
  return "Worksheet";
}

// 📦 Module or Chapter detector
function detectModule(name) {
  const lowered = name.toLowerCase();

  // Detect chapter number first (e.g. "Chapter 1" or "Ch 1")
  const chapterMatch = lowered.match(/ch(?:apter)?\.?\s*(\d+)/);
  if (chapterMatch) return `Chapter ${chapterMatch[1]}`;

  // Detect module number (e.g. "Module 2" or "M 2")
  const moduleMatch = lowered.match(/(m|module)\s?-?\s?(\d+)/);
  if (moduleMatch) return `Module ${moduleMatch[2]}`;

  return "Uncategorized";
}

// 🧠 Submission Status helper
function detectSubmissionStatus(assignment) {
  if (assignment.submission && assignment.submission.submitted_at) {
    const submittedAt = new Date(assignment.submission.submitted_at);
    const dueAt = assignment.due_at ? new Date(assignment.due_at) : null;

    if (dueAt && submittedAt > dueAt) {
      return "⏰ Delayed AF";
    } else {
      return "✨ Dominated";
    }
  } else if (assignment.due_at && new Date() > new Date(assignment.due_at)) {
    return "💀 Never Gave";
  } else {
    return "🧠 Manifesting Productivity";
  }
}

// Helper to fetch all pages of paginated Canvas API results
const fetchAllPages = async (url, token) => {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Canvas API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    results = results.concat(data);

    // Parse Link header to find next page URL if exists
    const linkHeader = response.headers.get("link");
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = nextMatch ? nextMatch[1] : null;
    } else {
      nextUrl = null;
    }
  }

  return results;
};

// Helper to clean assignment name by removing redundant prefixes, but keep "Exam" and "Quiz"
function cleanAssignmentName(name, type) {
  let cleanedName = name;

  // Keep 'Exam' and 'Quiz' prefixes in the name; clean others
  if (type && !["exam", "quiz"].includes(type.toLowerCase())) {
    const typeLower = type.toLowerCase();
    const regexType = new RegExp(`^${typeLower}:?\\s*`, "i");
    cleanedName = cleanedName.replace(regexType, "");

    // Remove module/chapter prefix like "M9", "Module 9", "Ch 1", "Chapter 1"
    const regexModuleChapter = /^(m(odule)?\s*\d+|ch(apter)?\.?\s*\d+)\s*[-:]?\s*/i;
    cleanedName = cleanedName.replace(regexModuleChapter, "");
  }

  return cleanedName.trim();
}

// Rename specific short answer worksheets to a cleaner title
function renameShortAnswerWorksheet(name) {
  // Matches "M5 Worksheet: Short-Answer Questions" or similar
  const regex = /^M\d+\s+Worksheet:\s+Short-Answer Questions$/i;
  if (regex.test(name)) {
    return "Quiz (Short Answer)";
  }
  return name;
}

// --- New: Fetch modules for a course ---
async function fetchModules(course, token) {
  const modules = await fetchAllPages(`${course.baseUrl || course.url || course.base_url}/api/v1/courses/${course.id}/modules`, token);
  console.log(`   ➤ Found ${modules.length} modules for course ${course.name}`);
  return modules;
}

// --- New: Fetch module items for a module ---
async function fetchModuleItems(course, module, token) {
  const moduleItems = await fetchAllPages(`${course.baseUrl || course.url || course.base_url}/api/v1/courses/${course.id}/modules/${module.id}/items`, token);
  console.log(`      ➤ Found ${moduleItems.length} items in module "${module.name}"`);
  return moduleItems;
}

// --- New: Fetch and parse module item content HTML ---
async function fetchAndParseModuleItemContent(course, item, token) {
  if (!item.url) {
    console.log(`         ⚠️ No URL for module item "${item.title}"`);
    return null;
  }

  try {
    const response = await fetch(item.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.log(`         ⚠️ Failed to fetch module item content: ${response.status} ${response.statusText}`);
      return null;
    }

    const html = await response.text();

    const $ = cheerio.load(html);

    // Example: Extract text inside <div class="content"> or any other relevant selectors you find from Canvas pages
    const contentText = $("div.content, div.syllabus, div.lecture-content").text().trim();

    return contentText || null;
  } catch (error) {
    console.error(`         ❌ Error fetching/parsing module item content: ${error.message}`);
    return null;
  }
}

// 🛠 SYNC route - sync assignments + module content from Canvas to Notion with pagination and scraping
app.get("/sync", async (req, res) => {
  console.log("SYNC ROUTE HIT");

  let totalCreated = 0;

  for (const config of canvasConfigs) {
    console.log(`🔍 Syncing from ${config.label}...`);
    try {
      // Fetch all courses (all pages)
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);
      console.log(`   ➤ Got ${courses.length} courses`);

      for (const course of courses) {
        if (!course.name || !course.id) continue;
        console.log(`📘 Course: ${course.name} (${course.id})`);

        // Fetch all assignments (all pages) for each course
        const assignments = await fetchAllPages(`${config.baseUrl}/api/v1/courses/${course.id}/assignments`, config.token);
        console.log(`   ➤ Found ${assignments.length} assignments for ${course.name}`);

        // Log assignment names for debugging
        assignments.forEach(a => console.log(`      🔍 Raw assignment: ${a.name}`));

        // Fetch modules to get extra content (readings, animations, lectures inside modules)
        let modules = [];
        try {
          modules = await fetchModules(course, config.token);
        } catch (modErr) {
          console.error(`      ❌ Failed to fetch modules for ${course.name}: ${modErr.message}`);
        }

        // For each module, fetch module items and scrape content
        for (const module of modules) {
          let moduleItems = [];
          try {
            moduleItems = await fetchModuleItems(course, module, config.token);
          } catch (itemErr) {
            console.error(`         ❌ Failed to fetch module items for module ${module.name}: ${itemErr.message}`);
          }

          for (const item of moduleItems) {
            // Only try scraping if item has a URL (usually pages, files, external URLs)
            if (!item.url) continue;

            const contentText = await fetchAndParseModuleItemContent(course, item, config.token);

            if (contentText) {
              console.log(`         ✨ Scraped content from "${item.title}":\n${contentText.substring(0, 200)}...`);
              // You could extend here: Create or update Notion pages with this content if you want
            }
          }
        }

        // Now sync assignments to Notion (create or update)
        for (const assignment of assignments) {
          // Check if this assignment already exists in Notion by Canvas Assignment ID
          const existingAssignment = await notion.databases.query({
            database_id: NOTION_DB_ID,
            filter: {
              property: "Canvas Assignment ID",
              rich_text: {
                equals: assignment.id.toString(),
              },
            },
          });

          // Prepare cleaned name and type
          const detectedType = detectTypeFromName(assignment.name);
          let cleanName = cleanAssignmentName(assignment.name, detectedType);
          cleanName = renameShortAnswerWorksheet(cleanName);

          const coursePageId = await findCoursePageId(course.name);
          if (!coursePageId) {
            console.log(`⚠️ No matching Notion course page for "${course.name}", skipping this assignment.`);
            continue;
          }

          if (existingAssignment.results.length > 0) {
            // If exists, update the existing page
            const pageId = existingAssignment.results[0].id;

            try {
              await notion.pages.update({
                page_id: pageId,
                properties: {
                  Name: {
                    title: [{ text: { content: cleanName } }],
                  },
                  Type: {
                    select: { name: detectedType },
                  },
                  Due: assignment.due_at
                    ? { date: { start: assignment.due_at } }
                    : undefined,
                  "Chapter/Module": {
                    rich_text: [{ text: { content: detectModule(assignment.name) } }],
                  },
                  "Submission Status": {
                    multi_select: [{ name: detectSubmissionStatus(assignment) }],
                  },
                  Course: {
                    relation: [{ id: coursePageId }],
                  },
                  "Canvas Assignment ID": {
                    rich_text: [{ text: { content: assignment.id.toString() } }],
                  },
                },
              });

              console.log(`♻️ Updated assignment "${assignment.name}"`);
            } catch (updateErr) {
              console.error(`❌ Failed to update Notion page: ${updateErr.message}`);
            }
          } else {
            // If not exists, create a new page
            try {
              await notion.pages.create({
                parent: { database_id: NOTION_DB_ID },
                properties: {
                  Name: {
                    title: [{ text: { content: cleanName } }],
                  },
                  Type: {
                    select: { name: detectedType },
                  },
                  Due: assignment.due_at
                    ? { date: { start: assignment.due_at } }
                    : undefined,
                  "Chapter/Module": {
                    rich_text: [{ text: { content: detectModule(assignment.name) } }],
                  },
                  "Submission Status": {
                    multi_select: [{ name: detectSubmissionStatus(assignment) }],
                  },
                  Course: {
                    relation: [{ id: coursePageId }],
                  },
                  "Canvas Assignment ID": {
                    rich_text: [{ text: { content: assignment.id.toString() } }],
                  },
                },
              });

              totalCreated++;
              console.log(`✅ Created assignment "${assignment.name}"`);
            } catch (createErr) {
              console.error(`❌ Failed to create Notion page: ${createErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error syncing ${config.label}:`, err.message);
    }
  }

  res.send(`✅ Synced ${totalCreated} assignments to Notion!`);
});
// 🔓 Welcome route
app.get("/", (req, res) => {
  res.send("👋 Welcome to your Notion Class Importer!");
});

// 📚 Course list route
app.get("/courses", async (req, res) => {
  const courseList = [];

  for (const config of canvasConfigs) {
    try {
      const coursesRes = await fetch(`${config.baseUrl}/api/v1/courses`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      const courses = await coursesRes.json();

      for (const course of courses) {
        courseList.push({
          id: course.id,
          name: course.name,
          label: config.label,
        });
      }
    } catch (err) {
      console.error(`❌ Error fetching courses for ${config.label}:`, err.message);
    }
  }

  res.json(courseList);
});

app.get("/test-canvas", async (req, res) => {
  try {
    const response = await fetch(`${canvasConfigs[0].baseUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${canvasConfigs[0].token}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});