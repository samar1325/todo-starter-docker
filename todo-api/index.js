const express = require("express");

const bodyParser = require("body-parser");
const { Pool } = require("pg");
const redis = require("redis");
var elasticsearch = require("elasticsearch");
const envProps = require("./env_props");

// Initializing the Express Framework /////////////////////////////////////////////////////
const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

// Postgres Client Setup /////////////////////////////////////////////////////
const postgresClient = new Pool({
  host: envProps.postgresHost,
  port: envProps.postgresPort,
  database: envProps.postgresDatabase,
  user: envProps.postgresUser,
  password: envProps.postgresPassword,
  max: 10, // Max number of connections in the pool
  idleTimeoutMillis: 30000, // Connection timeout 30 seconds
});

// Redis Client Setup /////////////////////////////////////////////////////
const redisClient = redis.createClient({
  host: envProps.redisHost,
  port: envProps.redisPort,
  enable_offline_queue: false,
  retry_strategy: () => 1000, // try reconnecting after 1 sec.
});
redisClient.on("connect", () => console.log("Redis client connected"));
redisClient.on("error", (err) =>
  console.log("Something went wrong with Redis: " + err)
);

// Elasticsearch Client Setup ///////////////////////////////////////////////
const elasticClient = new elasticsearch.Client({
  hosts: [envProps.elasticHost + ":" + envProps.elasticPort],
});
const TODO_SEARCH_INDEX_NAME = "todos";
const TODO_SEARCH_INDEX_TYPE = "todo";
// Ping the client to be sure Elastic is up
elasticClient.ping(
  {
    requestTimeout: 30000,
  },
  function (error) {
    if (error) {
      console.error("Something went wrong with Elasticsearch: " + error);
    } else {
      console.log("Elasticsearch client connected");

      // Check if todo index already exists?
      var todoIndexExists = elasticClient.indices.exists(
        {
          index: TODO_SEARCH_INDEX_NAME,
        },
        function (error, response, status) {
          if (error) {
            console.log(error);
          } else {
            console.log("Todo index exists in Elasticsearch");
          }
        }
      );

      if (!todoIndexExists) {
        // Create a Todos index. If the index has already been created, then this function fails safely
        elasticClient.indices.create(
          {
            index: TODO_SEARCH_INDEX_NAME,
          },
          function (error, response, status) {
            if (error) {
              console.log(
                "Could not create Todo index in Elasticsearch: " + error
              );
            } else {
              console.log("Created Todo index in Elasticsearch");
            }
          }
        );
      }
    }
  }
);

// Set up the API routes /////////////////////////////////////////////////////

// Get all todos
app.route("/api/v1/todos").get(async (req, res) => {
  console.log("CALLED GET api/v1/todos");

  res.setHeader("Content-Type", "application/json");

  // First, try get todos from cache (get all members of Set)
  await redisClient.smembers("todos", async (error, cachedTodoSet) => {
    //["Get kids from school","Take out the trash","Go shopping"]
    if (error) {
      console.log("  Redis get todos error: " + error);
    }

    var todos = []; // [{"title":"Get kids from school"},{"title":"Take out the trash"},{"title":"Go shopping"}]
    if (cachedTodoSet == null || cachedTodoSet.length == 0) {
      // Nothing in cache, get from database
      postgresClient.connect((err, client) => {
        if (err) {
          console.log("Could not connect to Postgres when getAllTodos: " + err);
        } else {
          console.log("Postgres client connected when getAllTodos");

          client.query("SELECT title FROM todo", (error, todoRows) => {
            if (error) {
              throw error;
            }
            todos = todoRows.rows; // [{"title":"Get kids from school"},{"title":"Take out the trash"},{"title":"Go shopping"}]
            console.log("  Got todos from PostgreSQL db: " + todos);

            if (todos != null && todos.length > 0) {
              // Now, we got todos in the database but not in cache, so add them to cache
              for (var i = 0; i < todos.length; i++) {
                console.log("  Adding Todo: [" + todos[i].title + "] to Cache");
                redisClient.sadd(["todos", todos[i].title], (error, reply) => {
                  if (error) {
                    throw error;
                  }
                });
              }
            }

            res.send(todos);
          });
        }
      });
    } else {
      for (var i = 0; i < cachedTodoSet.length; i++) {
        todos.push({ title: cachedTodoSet[i] });
      }
      console.log("  Got todos from Redis cache: " + todos);
      res.send(todos);
    }
  });
});

// Create a new todo
app.route("/api/v1/todos").post(async (req, res) => {
  const todoTitle = req.body.title;

  console.log("CALLED POST api/v1/todos with title=" + todoTitle);

  // Insert todo in postgres DB
  postgresClient.connect((err, client) => {
    if (err) {
      console.log("Could not connect to Postgres in AddTodo: " + err);
    } else {
      console.log("Postgres client connected in AddTodo");

      client.query(
        "INSERT INTO todo(title) VALUES($1)",
        [todoTitle],
        (error, reply) => {
          if (error) {
            throw error;
          }
          console.log("  Added Todo: [" + todoTitle + "] to Database");
        }
      );
    }
  });

  // Update the Redis cache (add the todo text to the Set in Redis)
  await redisClient.sadd(["todos", todoTitle], (error, reply) => {
    if (error) {
      throw error;
    }
    console.log("  Added Todo: [" + todoTitle + "] to Cache");
  });

  // Update the search index
  await elasticClient.index(
    {
      index: TODO_SEARCH_INDEX_NAME,
      type: TODO_SEARCH_INDEX_TYPE,
      body: { todotext: todoTitle },
    },
    function (err, resp, status) {
      if (err) {
        console.log("Could not index " + todoTitle + ": " + err);
      }
      console.log("  Added Todo: [" + todoTitle + "] to Search Index");
    }
  );

  res.status(201).send(req.body);
});

// Search all todos
app.route("/api/v1/search").post(async (req, res) => {
  const searchText = req.body.searchText;

  console.log("CALLED POST api/v1/search with searchText=" + searchText);

  // Perform the actual search passing in the index, the search query and the type
  await elasticClient
    .search({
      index: TODO_SEARCH_INDEX_NAME,
      type: TODO_SEARCH_INDEX_TYPE,
      body: {
        query: {
          match: {
            todotext: searchText,
          },
        },
      },
    })
    .then((results) => {
      console.log(
        'Search for "' + searchText + '" matched: ' + results.hits.hits
      );
      res.send(results.hits.hits);
    })
    .catch((err) => {
      console.log(err);
      res.send([]);
    });
});

// Start the server /////////////////////////////////////////////////////
app.listen(port, () => {
  console.log("Todo API Server started!");
});
