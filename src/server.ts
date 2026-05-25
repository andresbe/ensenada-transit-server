import { app } from "./app";
import { env } from "./config/env";

app.listen(env.port, () => {
  console.log(`Ensenada Transit location service listening on port ${env.port}`);
});
