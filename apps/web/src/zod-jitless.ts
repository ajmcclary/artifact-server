import {z} from "zod";

// Zod's JIT probe calls `new Function("")`. The application and review-frame
// policies (`script-src 'self'`) block it and report a securitypolicyviolation
// even though Zod catches the failure, so both documents parse interpreted.
// Import this module first in every entry, before anything builds a schema.
z.config({jitless: true});
