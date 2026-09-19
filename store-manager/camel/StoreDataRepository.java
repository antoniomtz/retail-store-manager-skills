import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

final class StoreDataRepository {
    private final ObjectMapper json = new ObjectMapper();
    private final Path dataDirectory;

    StoreDataRepository(String dataDirectory) {
        this.dataDirectory = Path.of(dataDirectory).toAbsolutePath().normalize();
    }

    ObjectMapper mapper() {
        return json;
    }

    JsonNode source(String filename) throws IOException {
        Path source = dataDirectory.resolve(filename).normalize();
        if (!source.getParent().equals(dataDirectory)) {
            throw new IOException("source file is outside the Store Manager data directory");
        }
        return json.readTree(Files.readString(source));
    }
}
