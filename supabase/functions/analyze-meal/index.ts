import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
const GROQ_MODEL = "qwen/qwen3.6-27b"
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_MEAL_DESCRIPTION_CHARS = 500

type NutritionValue = Record<string, unknown>

export default {
  fetch: withSupabase({ auth: "user" }, async (req) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 })
    }

    const apiKey = Deno.env.get("GROQ_API_KEY")
    if (!apiKey) {
      return Response.json({ error: "Analysis service is not configured" }, { status: 500 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const imageDataUrl = String(body.imageDataUrl || "")
    const mealDescription = String(body.mealDescription || "").trim()
    const hasImage = Boolean(imageDataUrl)
    const hasDescription = Boolean(mealDescription)

    if (!hasImage && !hasDescription) {
      return Response.json({ error: "Add a meal photo or type what you ate." }, { status: 400 })
    }
    if (hasImage && !isValidImageDataUrl(imageDataUrl)) {
      return Response.json({ error: "imageDataUrl must be a supported image" }, { status: 400 })
    }
    if (hasImage && estimateDataUrlBytes(imageDataUrl) > MAX_IMAGE_BYTES) {
      return Response.json({ error: "Image is too large. Please upload a smaller meal photo." }, { status: 413 })
    }
    if (mealDescription.length > MAX_MEAL_DESCRIPTION_CHARS) {
      return Response.json({ error: "Meal details are too long. Keep it under 500 characters." }, { status: 413 })
    }

    const messageContent: Array<Record<string, unknown>> = [{
      type: "text",
      text: buildPrompt(hasImage, mealDescription),
    }]
    if (hasImage) {
      messageContent.push({ type: "image_url", image_url: { url: imageDataUrl } })
    }

    let groqResponse: Response
    try {
      groqResponse = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: messageContent }],
          temperature: 0.2,
          max_completion_tokens: 1200,
          response_format: { type: "json_object" },
          reasoning_effort: "none",
          reasoning_format: "hidden",
        }),
      })
    } catch {
      return Response.json({ error: "Could not reach the analysis service" }, { status: 502 })
    }

    const data = await groqResponse.json().catch(() => ({})) as NutritionValue
    if (!groqResponse.ok) {
      const groqError = data.error as NutritionValue | undefined
      const message = String(groqError?.message || `Analysis service returned ${groqResponse.status}`)
      return Response.json({ error: message }, { status: 502 })
    }

    const choices = data.choices as Array<NutritionValue> | undefined
    const message = choices?.[0]?.message as NutritionValue | undefined
    const content = message?.content
    try {
      const nutrition = typeof content === "string" ? JSON.parse(content) : content
      return Response.json(normalizeNutrition((nutrition || {}) as NutritionValue))
    } catch {
      return Response.json({ error: "The nutrition response could not be read" }, { status: 502 })
    }
  }),
}

function buildPrompt(hasImage: boolean, mealDescription: string) {
  const task = hasImage
    ? "Analyze this food photo"
    : `Estimate nutrition for this typed meal description: ${JSON.stringify(mealDescription)}`

  return `You are a registered dietitian AI. ${task} and return a JSON object only, with this exact shape:
{
  "food_name": "Human-readable name of the dish",
  "serving_description": "Estimated serving size",
  "calories": 0,
  "protein_g": 0,
  "carbohydrates_g": 0,
  "fat_g": 0,
  "fiber_g": 0,
  "sugar_g": 0,
  "saturated_fat_g": 0,
  "sodium_mg": 0,
  "potassium_mg": 0,
  "cholesterol_mg": 0,
  "vitamins": {
    "vitamin_a_mcg": 0,
    "vitamin_b6_mg": 0,
    "vitamin_b12_mcg": 0,
    "vitamin_c_mg": 0,
    "vitamin_d_mcg": 0,
    "vitamin_e_mg": 0,
    "vitamin_k_mcg": 0,
    "folate_mcg": 0,
    "niacin_mg": 0
  },
  "minerals": {
    "calcium_mg": 0,
    "iron_mg": 0,
    "magnesium_mg": 0,
    "phosphorus_mg": 0,
    "zinc_mg": 0,
    "selenium_mcg": 0
  }
}
Use numbers only for numeric values. If the food is unclear, provide reasonable estimates.`
}

function isValidImageDataUrl(value: string) {
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)
}

function estimateDataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] || ""
  return Math.ceil((base64.length * 3) / 4)
}

function normalizeNutrition(n: NutritionValue) {
  return {
    food_name: String(n.food_name || "Estimated meal"),
    serving_description: String(n.serving_description || "Estimated serving"),
    calories: num(n.calories),
    protein_g: num(n.protein_g),
    carbohydrates_g: num(n.carbohydrates_g),
    fat_g: num(n.fat_g),
    fiber_g: num(n.fiber_g),
    sugar_g: num(n.sugar_g),
    saturated_fat_g: num(n.saturated_fat_g),
    sodium_mg: num(n.sodium_mg),
    potassium_mg: num(n.potassium_mg),
    cholesterol_mg: num(n.cholesterol_mg),
    vitamins: isRecord(n.vitamins) ? n.vitamins : {},
    minerals: isRecord(n.minerals) ? n.minerals : {},
  }
}

function isRecord(value: unknown): value is NutritionValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function num(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
