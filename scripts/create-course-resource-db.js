
import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const parentPageId = process.env.NOTION_ROOT_PAGE_ID; // the top-level Notion page where the DB should be created
const coursePlannerDbId = process.env.COURSE_PLANNER_DB; // your existing Course Planner DB

async function createCourseResourceDatabase() {
  try {
    const response = await notion.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [
        {
          type: "text",
          text: { content: "📚 Course Resource Database" },
        },
      ],
      properties: {
        Name: { title: {} },
        Content: { rich_text: {} },
        Type: {
          select: {
            options: [
              { name: "Page", color: "blue" },
              { name: "File", color: "green" },
              { name: "Quiz", color: "red" },
              { name: "Link", color: "purple" },
            ],
          },
        },
        Course: {
          relation: {
            database_id: coursePlannerDbId,
            type: "dual_property",
            dual_property: {},
          },
        },
        Module: { rich_text: {} },
        Assignments: {
          relation: {
            database_id: "temporary_placeholder", // You can update this later!
          },
        },
        "Canvas Module Item ID": { rich_text: {} },
        Link: { url: {} },
        "Last Synced": { date: {} },
        "Auto-generated": { checkbox: {} },
      },
    });

    console.log("🎉 Your new Notion DB is ready:", response.id);
  } catch (err) {
    console.error("💥 Something broke:", err.message);
  }
}

createCourseResourceDatabase();
