// Sample programs for the "Examples…" menu in paste mode.

export const EXAMPLES = [
  {
    id: 'simple',
    label: 'Simple function',
    code: `/**
 * Adds up the positive numbers in a list.
 * Negative numbers and zero are skipped.
 */
function sumPositive(numbers) {
  let total = 0;
  for (const n of numbers) {
    if (n > 0) {
      total += n;
    } else {
      console.log("skipping", n);
    }
  }
  return total;
}
`,
  },
  {
    id: 'branches',
    label: 'Loops & branches',
    code: `// Counts how many numbers are even, odd, or zero.
function tally(numbers) {
  const counts = { even: 0, odd: 0, zero: 0 };
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    if (n === 0) {
      counts.zero++;
      continue;
    } else if (n % 2 === 0) {
      counts.even++;
    } else {
      counts.odd++;
    }
  }
  return counts;
}

function describeDay(day) {
  switch (day) {
    case 0:
    case 6:
      return "weekend";
    case 5:
      return "almost the weekend";
    default:
      return "weekday";
  }
}

// Halves a value until it drops below the limit.
function stepsToShrink(value, limit) {
  let steps = 0;
  while (value >= limit) {
    value = value / 2;
    steps++;
  }
  return steps;
}
`,
  },
  {
    id: 'async',
    label: 'Async & error handling',
    code: `const API_URL = "https://api.example.com";

/**
 * Loads a user's profile, using the cache when possible.
 * Returns null if the request fails.
 */
async function loadProfile(userId, cache) {
  if (cache.has(userId)) {
    return cache.get(userId);
  }

  try {
    const response = await fetch(\`\${API_URL}/users/\${userId}\`);
    if (!response.ok) {
      throw new Error(\`Request failed: \${response.status}\`);
    }
    const profile = await response.json();
    cache.set(userId, profile);
    return profile;
  } catch (err) {
    console.error("Could not load profile", err);
    return null;
  }
}

async function loadAll(ids) {
  const cache = new Map();
  const profiles = [];
  for (const id of ids) {
    const profile = await loadProfile(id, cache);
    if (profile) profiles.push(profile);
  }
  return profiles;
}
`,
  },
  {
    id: 'class',
    label: 'Class with methods',
    code: `// A tiny shopping cart.
class Cart {
  constructor(taxRate = 0.08) {
    this.items = [];
    this.taxRate = taxRate;
  }

  // Adds an item, or bumps its quantity if it is already in the cart.
  add(item, qty = 1) {
    const existing = this.items.find((i) => i.id === item.id);
    if (existing) {
      existing.qty += qty;
    } else {
      this.items.push({ ...item, qty });
    }
  }

  total() {
    let sum = 0;
    for (const item of this.items) {
      sum += item.price * item.qty;
    }
    return sum * (1 + this.taxRate);
  }
}

const cart = new Cart();
cart.add({ id: 1, price: 9.99 }, 2);
console.log(cart.total());
`,
  },
];
